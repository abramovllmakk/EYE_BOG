import { request } from 'undici';
import { describe, expect, it } from 'vitest';
import { startHarness } from './helpers.js';

const metric = async (adminUrl: string, name: string) => {
  const text = await (await request(adminUrl + '/metrics')).body.text();
  return text
    .split('\n')
    .filter((l) => l.startsWith(name))
    .join('\n');
};

describe('fail-open', () => {
  it('analyzer crash never breaks proxying', async () => {
    const h = await startHarness(
      {},
      {
        pipelineHooks: {
          beforeAnalyze: () => {
            throw new Error('boom');
          },
        },
      },
    );
    try {
      const res = await h.gql({ query: '{ viewer { name } }' });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toEqual({ data: { viewer: { name: 'Alice' } } });
      await h.app.pipeline.idle();
      expect(await metric(h.adminUrl, 'gqlcov_errors_total')).toContain('component="analyzer"} 1');
    } finally {
      await h.close();
    }
  });

  it('storage failure (writes and reads) never breaks proxying', async () => {
    const h = await startHarness();
    try {
      const fail = () => Promise.reject(new Error('disk on fire'));
      h.app.storage.write = fail;
      h.app.storage.getRun = fail;
      h.app.storage.createRun = fail;
      h.app.storage.activeExplicitRun = fail;
      for (let i = 0; i < 5; i++) {
        const res = await h.gql({ query: '{ tags { name } }' }, { 'x-coverage-run-id': `r${i}` });
        expect(res.status).toBe(200);
      }
      await h.app.pipeline.idle();
      expect(await metric(h.adminUrl, 'gqlcov_errors_total')).toMatch(/component="analyzer"} 5/);
    } finally {
      await h.close();
    }
  });

  it('enqueue failure and a full queue never break proxying', async () => {
    let n = 0;
    const h = await startHarness(
      { queue: { maxSize: 1, flushIntervalMs: 50 } },
      {
        beforeEnqueue: () => {
          if (n++ === 0) throw new Error('enqueue boom');
        },
      },
    );
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => h.gql({ query: '{ tags { name } }' })),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await metric(h.adminUrl, 'gqlcov_errors_total')).toContain(
        'component="proxy-enqueue"} 1',
      );
      await h.app.pipeline.idle();
    } finally {
      await h.close();
    }
  });

  it('works without a schema (backend introspection disabled) and explains how to fix it', async () => {
    const h = await startHarness({}, { demo: { disableIntrospection: true } });
    try {
      const res = await h.gql({ query: '{ viewer { name } }' });
      expect(res.status, res.text).toBe(200);
      const targets = await h.api<
        { name: string; error: { message: string; hint: string } | null }[]
      >('GET', '/api/targets');
      const demo = targets.json.find((t) => t.name === 'demo')!;
      expect(demo.error!.message).toMatch(/Introspection is disabled or failed/);
      expect(demo.error!.hint).toMatch(/gqlcov schema upload/);
      const refresh = await h.api<{ error: string; hint: string }>('POST', '/api/schemas/refresh', {
        target: 'demo',
      });
      expect(refresh.status).toBe(422);
      expect(refresh.json.hint).toMatch(/schema upload/);
      expect((await h.api('GET', '/readyz')).status).toBe(503);
      await h.app.pipeline.idle();
      const runs = await h.api<{ items: { id: string }[] }>('GET', '/api/runs');
      const ops = await h.api<{ items: { status: string }[] }>(
        'GET',
        `/api/runs/${runs.json.items[0]!.id}/operations`,
      );
      expect(ops.json.items[0]!.status).toBe('no_schema');
    } finally {
      await h.close();
    }
  });
});

describe('secrets', () => {
  const SECRETS = [
    'Bearer super-secret-123',
    'sid=cookie-secret',
    'key-secret-456',
    'pw-secret-789',
  ];

  for (const policy of ['structure', 'full'] as const) {
    it(`never stores or logs secrets (variables policy: ${policy})`, async () => {
      const h = await startHarness({ logging: { level: 'debug', variables: policy } });
      try {
        await h.gql(
          {
            query: 'query($id: ID!, $password: String) { user(id: $id) { name } }',
            variables: { id: 'u1', password: 'pw-secret-789' },
          },
          {
            authorization: 'Bearer super-secret-123',
            cookie: 'sid=cookie-secret',
            'x-api-key': 'key-secret-456',
            'x-coverage-run-id': 'sec',
          },
        );
        await h.gql(
          { query: '{ viewer { nope } }' },
          { authorization: 'Bearer super-secret-123', 'x-coverage-run-id': 'sec' },
        );
        await h.app.pipeline.idle();
        const ops = await h.api<{ items: unknown[] }>('GET', '/api/runs/sec/operations');
        const dump = JSON.stringify(ops.json) + h.logs.join('\n');
        for (const s of SECRETS) expect(dump).not.toContain(s);
        const first = ops.json.items[1] as {
          headers: Record<string, string>;
          variables: Record<string, unknown>;
        };
        expect(first.headers.authorization).toBe('***');
        expect(first.headers.cookie).toBe('***');
        expect(first.headers['x-api-key']).toBe('***');
        expect(first.variables).toEqual(
          policy === 'structure'
            ? { id: '<string>', password: '<string>' }
            : { id: 'u1', password: '***' },
        );
      } finally {
        await h.close();
      }
    });
  }
});
