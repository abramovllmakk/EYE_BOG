/**
 * Self-contained HTML coverage report: one file, no external resources, prints on A4.
 * Meant as a CI artifact or an attachment to a merge request / review.
 */
import type { CoverageReport, GapPlan, ImpactReport, Insights } from '@gqlcov/core';
import type { RunRow } from './storage/storage.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
const tone = (n: number) => (n >= 80 ? 'ok' : n >= 50 ? 'mid' : 'low');

function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

const meter = (label: string, value: number, detail: string) => `
  <div class="metric">
    <div class="label">${esc(label)}</div>
    <div class="value">${pct(value)}</div>
    <div class="bar"><span class="${tone(value)}" style="width:${Math.max(value, value > 0 ? 2 : 0)}%"></span></div>
    <div class="detail">${esc(detail)}</div>
  </div>`;

const list = (items: string[]) =>
  items.length ? `<ul class="codes">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '';

export interface HtmlReportInput {
  run: RunRow;
  report: CoverageReport;
  plan: GapPlan;
  insights: Insights;
  impact: ImpactReport;
  generatedAt?: Date;
}

export function renderHtmlReport({
  run,
  report,
  plan,
  insights: ins,
  impact,
  generatedAt = new Date(),
}: HtmlReportInput): string {
  const s = report.summary;
  const label =
    [run.branch, run.environment, run.buildId && `#${run.buildId}`].filter(Boolean).join(' / ') ||
    run.id;
  const signals: [number, string, string[]][] = [
    [
      ins.deprecatedInUse.length,
      `${plural(ins.deprecatedInUse.length, 'устаревшее (@deprecated) поле', 'устаревших (@deprecated) поля', 'устаревших (@deprecated) полей')} ещё в тестах`,
      ins.deprecatedInUse.map((d) => d.coordinate),
    ],
    [
      ins.untestedMutations.length,
      `${plural(ins.untestedMutations.length, 'мутация', 'мутации', 'мутаций')} без тестов`,
      ins.untestedMutations,
    ],
    [
      ins.untestedSubscriptions.length,
      `${plural(ins.untestedSubscriptions.length, 'подписка', 'подписки', 'подписок')} без тестов`,
      ins.untestedSubscriptions,
    ],
    [
      ins.untouchedTypes.length,
      `${plural(ins.untouchedTypes.length, 'тип не затронут', 'типа не затронуто', 'типов не затронуто')} вовсе`,
      ins.untouchedTypes,
    ],
    [
      ins.conditionalOnly.length,
      `${plural(ins.conditionalOnly.length, 'поле покрыто', 'поля покрыты', 'полей покрыто')} только условно`,
      ins.conditionalOnly,
    ],
    [
      ins.unusedArguments.length,
      `${plural(ins.unusedArguments.length, 'аргумент ни разу не передан', 'аргумента ни разу не переданы', 'аргументов ни разу не передано')}`,
      ins.unusedArguments,
    ],
  ];
  const active = signals.filter(([n]) => n > 0);
  const byType = new Map<string, string[]>();
  for (const c of report.uncovered.fields) {
    const [t, f] = c.split('.') as [string, string];
    byType.set(t, [...(byType.get(t) ?? []), f]);
  }

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Покрытие GraphQL: ${esc(label)}</title>
<style>
  :root { --ink:#161b22; --muted:#5d6877; --line:#d9dee5; --bg:#f1f3f6; --ok:#22895e; --mid:#c98a0c; --low:#c2413a; --accent:#2f55d4; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font: 14px/1.5 -apple-system, 'Segoe UI', Roboto, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 24px 48px; }
  header { display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; align-items:baseline; }
  h1 { font-size: 22px; margin: 0; } h2 { font-size: 16px; margin: 32px 0 10px; }
  .muted { color: var(--muted); }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 10px; margin-top: 18px; }
  .metric, .card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
  .metric .label, .detail { color: var(--muted); font-size: 12px; }
  .metric .value { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .bar { height:6px; background:#e9ecf0; border-radius:99px; overflow:hidden; margin:6px 0 4px; }
  .bar span { display:block; height:100%; border-radius:99px; }
  .ok { background: var(--ok); } .mid { background: var(--mid); } .low { background: var(--low); }
  .signals { display:grid; gap:10px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
  .signals b { font-size: 20px; margin-right: 6px; color: var(--low); }
  ul.codes { list-style:none; padding:0; margin:8px 0 0; display:flex; flex-wrap:wrap; gap:4px 12px; }
  code, ul.codes li, pre { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 12.5px; }
  pre { background:#f5f7f9; border:1px solid var(--line); border-radius:6px; padding:10px 12px; overflow:auto; margin:8px 0 0; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; color:var(--muted); font-weight:500; }
  td.num, th.num { font-variant-numeric: tabular-nums; text-align:right; }
  .step { break-inside: avoid; }
  footer { margin-top: 40px; font-size: 12px; color: var(--muted); }
  @media print { body { background:#fff; } main { padding: 0; } .metric, .card { break-inside: avoid; } }
</style>
</head>
<body><main>
<header>
  <div>
    <div class="muted">Сеть глазами Бога · отчёт о покрытии GraphQL-схемы тестами</div>
    <h1>${esc(label)}</h1>
  </div>
  <div class="muted">Прогон ${esc(run.id)}<br>начат ${esc(new Date(run.startedAt).toLocaleString('ru-RU'))}</div>
</header>

<div class="grid">
  ${meter('Поля', s.fields.percent, `${s.fields.covered} из ${s.fields.total}`)}
  ${meter('Операции', s.operations.percent, `query ${s.operations.query.covered}/${s.operations.query.total}, mutation ${s.operations.mutation.covered}/${s.operations.mutation.total}`)}
  ${meter('Типы', s.types.percent, `${s.types.covered} из ${s.types.total}`)}
  ${meter('Аргументы', s.arguments.percent, `${s.arguments.covered} из ${s.arguments.total}`)}
  ${meter('Значения enum', s.enumValues.percent, `${s.enumValues.covered} из ${s.enumValues.total}`)}
  ${meter('Поля input', s.inputFields.percent, `${s.inputFields.covered} из ${s.inputFields.total}`)}
</div>
<p class="muted">Запросов: ${s.requests.total} (валидных ${s.requests.valid}, невалидных ${s.requests.invalid}). Тестов: ${s.tests}. Самый глубокий запрос: ${s.maxDepth}.</p>

${
  active.length
    ? `<h2>Сигналы риска</h2><div class="signals">${active
        .map(
          ([n, t, items]) =>
            `<div class="card"><b>${n}</b>${esc(t)}${list(items.slice(0, 30))}</div>`,
        )
        .join('')}</div>`
    : ''
}

<h2>Вклад тестов</h2>
<p>${impact.minimalSet.testKeys.length} из ${impact.tests.length} ${plural(impact.tests.length, 'теста', 'тестов', 'тестов')} дают то же покрытие полей (${impact.coveredFields} из ${impact.totalFields}). Полностью дублируют другие: ${impact.redundant}.</p>
<table>
  <thead><tr><th>Тест</th><th class="num">Полей</th><th class="num">Только этот тест</th></tr></thead>
  <tbody>${impact.tests
    .filter((t) => !t.empty)
    .slice(0, 25)
    .map(
      (t) =>
        `<tr><td>${esc(t.unnamed ? 'без имени (нет X-Test-Name)' : t.suite ? `${t.suite} / ${t.name}` : t.name)}</td><td class="num">${t.fields}</td><td class="num">${t.unique.length}</td></tr>`,
    )
    .join('')}</tbody>
</table>

${
  plan.suggestions.length
    ? `<h2>План покрытия</h2>
<p>${plan.suggestions.length} ${plural(plan.suggestions.length, 'запрос', 'запроса', 'запросов')} поднимут покрытие полей с ${pct(plan.fields.percent)} до ${pct(plan.projected)}. Значения переменных примерные.</p>
${plan.suggestions
  .slice(0, 15)
  .map(
    (g, i) => `<div class="card step" style="margin-top:10px">
  <div><b>${i + 1}. ${esc(g.operationName)}</b> <span class="muted">+${g.marginalGain} → ${pct(g.coverageAfter)}; покрывает ${esc(g.fields.join(', '))}</span></div>
  <pre>${esc(g.query)}</pre>${Object.keys(g.variables).length ? `<pre>${esc(JSON.stringify(g.variables, null, 2))}</pre>` : ''}
</div>`,
  )
  .join('')}`
    : ''
}

${
  byType.size
    ? `<h2>Непокрытые поля по типам</h2><table><thead><tr><th>Тип</th><th>Поля</th></tr></thead><tbody>${[
        ...byType,
      ]
        .map(
          ([t, fs]) =>
            `<tr><td><code>${esc(t)}</code></td><td><code>${esc(fs.join(', '))}</code></td></tr>`,
        )
        .join('')}</tbody></table>`
    : ''
}

<footer>Сформировано ${esc(generatedAt.toLocaleString('ru-RU'))}. Поле покрыто, если хотя бы раз выбрано в валидном запросе; introspection и __typename не учитываются.</footer>
</main></body></html>
`;
}
