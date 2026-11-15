import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, applyEnv, loadConfig, parseConfig } from '../src/config.js';

describe('config', () => {
  it('applies defaults', () => {
    const { config } = parseConfig({ targets: [{ name: 'a', url: 'http://x/graphql' }] });
    expect(config.server).toMatchObject({ proxyPort: 4000, adminPort: 4001 });
    expect(config.logging.variables).toBe('structure');
    expect(config.targets[0]!.schema.source).toBe('introspection');
    expect(config.runs.headers.testName).toBe('x-test-name');
  });

  it('overrides from env (nested, arrays, shortcuts)', () => {
    const raw = applyEnv(
      { targets: [{ name: 'a', url: 'http://x/graphql' }] },
      {
        GQLCOV_SERVER__PROXY_PORT: '8080',
        GQLCOV_TARGETS__0__SCHEMA__REFRESH_INTERVAL_SEC: '60',
        GQLCOV_LOGGING__MASK_HEADERS: '["authorization","x-secret"]',
        GQLCOV_COVERAGE__PROPAGATE_INTERFACE_COVERAGE: 'true',
        TARGET_URL: 'http://api:4100/graphql',
        AUTH_TOKEN: 't0k',
      },
    );
    const { config } = parseConfig(raw);
    expect(config.server.proxyPort).toBe(8080);
    expect(config.targets[0]!.url).toBe('http://api:4100/graphql');
    expect(config.targets[0]!.schema.refreshIntervalSec).toBe(60);
    expect(config.logging.maskHeaders).toEqual(['authorization', 'x-secret']);
    expect(config.coverage.propagateInterfaceCoverage).toBe(true);
    expect(config.auth.token).toBe('t0k');
  });

  it('builds a target from TARGET_URL alone', () => {
    const { config } = parseConfig({}, { TARGET_URL: 'http://api/graphql' });
    expect(config.targets[0]).toMatchObject({ name: 'default', url: 'http://api/graphql' });
  });

  it('reports readable errors', () => {
    expect(() => parseConfig({})).toThrow(/targets: /);
    expect(() => parseConfig({ targets: [{ name: 'a', url: 'not a url' }] })).toThrow(ConfigError);
    expect(() =>
      parseConfig({
        targets: [
          { name: 'a', url: 'http://x' },
          { name: 'a', url: 'http://y' },
        ],
      }),
    ).toThrow(/duplicate target name "a"/);
    expect(() =>
      parseConfig({ targets: [{ name: 'a', url: 'http://x', schema: { source: 'sdl' } }] }),
    ).toThrow(/schema.file: required/);
    expect(() =>
      parseConfig({ targets: [{ name: 'a', url: 'http://x' }], logging: { variables: 'all' } }),
    ).toThrow(/logging.variables/);
  });

  it('loads YAML files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gqlcov-'));
    const file = join(dir, 'gqlcov.yaml');
    writeFileSync(
      file,
      'targets:\n  - name: a\n    url: http://x/graphql\nserver:\n  adminPort: 5001\n',
    );
    const { config, baseDir } = loadConfig(file, {});
    expect(config.server.adminPort).toBe(5001);
    expect(baseDir).toBe(dir);
    writeFileSync(file, 'targets: [');
    expect(() => loadConfig(file, {})).toThrow(/not valid YAML/);
    expect(() => loadConfig(join(dir, 'missing.yaml'), {})).toThrow(/Cannot read config file/);
  });
});
