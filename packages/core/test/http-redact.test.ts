import { describe, expect, it } from 'vitest';
import {
  MASK,
  decodeHeaderValue,
  maskHeaders,
  parseHttpGraphQLRequest,
  parseOperationsJson,
  persistedQueryHash,
  redactVariables,
} from '../src/index.js';

describe('parseHttpGraphQLRequest', () => {
  it('parses POST JSON single and batch', () => {
    expect(
      parseHttpGraphQLRequest({
        method: 'POST',
        contentType: 'application/json',
        body: '{"query":"{a}","variables":{"x":1},"operationName":"A"}',
      }),
    ).toEqual({
      batch: false,
      requests: [{ query: '{a}', operationName: 'A', variables: { x: 1 }, extensions: null }],
    });
    const batch = parseHttpGraphQLRequest({
      method: 'post',
      body: '[{"query":"{a}"},{"query":"{b}","variables":[1]}]',
    });
    expect(batch).toMatchObject({
      batch: true,
      requests: [{ query: '{a}' }, { query: '{b}', variables: null }],
    });
  });

  it('parses application/graphql bodies', () => {
    expect(
      parseHttpGraphQLRequest({ method: 'POST', contentType: 'application/graphql', body: '{a}' }),
    ).toEqual({ batch: false, requests: [{ query: '{a}' }] });
    expect(parseHttpGraphQLRequest({ method: 'POST', contentType: 'application/graphql' })).toEqual(
      { batch: false, requests: [{ query: '' }] },
    );
    expect(
      parseHttpGraphQLRequest({
        method: 'POST',
        contentType: 'application/graphql-response+json',
        body: '{"query":"{a}"}',
      }),
    ).toMatchObject({ requests: [{ query: '{a}' }] });
  });

  it('parses GET params', () => {
    expect(
      parseHttpGraphQLRequest({
        method: 'GET',
        query: { query: '{a}', operationName: 'A', variables: '{"x":1}', extensions: 'not json' },
      }),
    ).toEqual({
      batch: false,
      requests: [{ query: '{a}', operationName: 'A', variables: { x: 1 }, extensions: null }],
    });
    expect(
      parseHttpGraphQLRequest({
        method: 'GET',
        query: { extensions: '{"persistedQuery":{"sha256Hash":"h"}}', variables: '[1]' },
      }),
    ).toEqual({
      batch: false,
      requests: [
        {
          query: null,
          operationName: null,
          variables: null,
          extensions: { persistedQuery: { sha256Hash: 'h' } },
        },
      ],
    });
    expect(parseHttpGraphQLRequest({ method: 'GET', query: { query: '{a}' } })).toEqual({
      batch: false,
      requests: [{ query: '{a}', operationName: null, variables: null, extensions: null }],
    });
    expect(parseHttpGraphQLRequest({ method: 'GET' })).toEqual({
      error: 'GET request without query',
    });
  });

  it('rejects malformed bodies', () => {
    expect(parseHttpGraphQLRequest({ method: 'PUT' })).toEqual({ error: 'Unsupported method PUT' });
    expect(parseHttpGraphQLRequest({ method: 'POST', body: '{' })).toEqual({
      error: 'Body is not valid JSON',
    });
    expect(parseHttpGraphQLRequest({ method: 'POST' })).toEqual({
      error: 'Body is not valid JSON',
    });
    expect(parseOperationsJson('[1]')).toEqual({ error: 'Batch must contain objects' });
    expect(parseOperationsJson('"x"')).toEqual({ error: 'Body must be an object or array' });
  });

  it('extracts APQ hashes', () => {
    expect(
      persistedQueryHash({ extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } } }),
    ).toBe('abc');
    expect(persistedQueryHash({ extensions: { persistedQuery: { sha256Hash: 1 } } })).toBeNull();
    expect(persistedQueryHash({ extensions: { persistedQuery: 'x' } })).toBeNull();
    expect(persistedQueryHash({})).toBeNull();
  });
});

describe('redaction', () => {
  const vars = {
    email: 'a@b.c',
    password: 'hunter2',
    n: 3,
    ok: true,
    nil: null,
    list: [{ apiKey: 'k', x: 'y' }],
  };

  it('keeps only structure by default policy', () => {
    expect(redactVariables(vars, 'structure')).toEqual({
      email: '<string>',
      password: '<string>',
      n: '<number>',
      ok: '<boolean>',
      nil: null,
      list: [{ apiKey: '<string>', x: '<string>' }],
    });
  });

  it('masks secret keys with full policy and drops with none', () => {
    expect(redactVariables(vars, 'full')).toEqual({
      ...vars,
      password: MASK,
      list: [{ apiKey: MASK, x: 'y' }],
    });
    expect(redactVariables(vars, 'none')).toBeNull();
    expect(redactVariables(null, 'full')).toBeNull();
    expect(redactVariables({ pin: '1' }, 'full', /pin/)).toEqual({ pin: MASK });
  });

  it('masks headers case-insensitively', () => {
    expect(
      maskHeaders(
        {
          Authorization: 'Bearer x',
          'x-api-key': 'k',
          accept: ['a', 'b'],
          cookie: undefined,
          host: 'h',
        },
        ['authorization', 'X-Api-Key', 'cookie'],
      ),
    ).toEqual({ Authorization: MASK, 'x-api-key': MASK, accept: 'a, b', host: 'h' });
  });
});

describe('decodeHeaderValue', () => {
  const asLatin1 = (s: string) => Buffer.from(s, 'utf8').toString('latin1'); // what Node gives us

  it('re-decodes raw UTF-8 bytes', () => {
    expect(decodeHeaderValue(asLatin1('мой первый тест'))).toBe('мой первый тест');
    expect(decodeHeaderValue(asLatin1('ветка/фича-1'))).toBe('ветка/фича-1');
  });

  it('decodes percent-encoded values', () => {
    expect(decodeHeaderValue(encodeURIComponent('логин админа'))).toBe('логин админа');
  });

  it('keeps ASCII, real latin1 and invalid sequences unchanged', () => {
    expect(decodeHeaderValue('login test')).toBe('login test');
    expect(decodeHeaderValue('café')).toBe('café'); // not valid UTF-8 bytes → genuine latin1
    expect(decodeHeaderValue('100% done')).toBe('100% done');
    expect(decodeHeaderValue('bad %E0%A4%A')).toBe('bad %E0%A4%A');
    expect(decodeHeaderValue('emoji 😀')).toBe('emoji 😀'); // already decoded text
    expect(decodeHeaderValue(undefined)).toBeUndefined();
  });
});
