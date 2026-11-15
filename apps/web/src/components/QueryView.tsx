/** Small GraphQL syntax highlighter (no editor dependency). */
const TOKEN =
  /(#[^\n]*)|("""[\s\S]*?"""|"(?:\\.|[^"\\])*")|(\$[_A-Za-z][_0-9A-Za-z]*)|(@[_A-Za-z][_0-9A-Za-z]*)|\b(query|mutation|subscription|fragment|on|true|false|null)\b|(-?\d+(?:\.\d+)?)|([_A-Za-z][_0-9A-Za-z]*)(?=\s*:)|([_A-Za-z][_0-9A-Za-z]*)|([{}()[\]!:=,|&.]+)|(\s+)/g;

export function QueryView({ text }: { text: string }) {
  const parts: { t: string; c: string }[] = [];
  let m: RegExpExecArray | null;
  let last = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index), c: '' });
    const [s] = m;
    const c = m[1]
      ? 'text-muted italic'
      : m[2]
        ? 'text-covered'
        : m[3]
          ? 'text-partial'
          : m[4]
            ? 'text-accent'
            : m[5]
              ? 'text-accent font-semibold'
              : m[6]
                ? 'text-partial'
                : m[7]
                  ? 'text-muted'
                  : '';
    parts.push({ t: s, c });
    last = m.index + s.length;
    if (s.length === 0) TOKEN.lastIndex++;
  }
  if (last < text.length) parts.push({ t: text.slice(last), c: '' });
  return (
    <pre className="overflow-auto rounded-md border border-line bg-surface-2 p-4 font-mono text-[13px] leading-relaxed">
      <code>
        {parts.map((p, i) => (
          <span key={i} className={p.c}>
            {p.t}
          </span>
        ))}
      </code>
    </pre>
  );
}
