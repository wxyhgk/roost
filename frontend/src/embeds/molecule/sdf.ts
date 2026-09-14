// SDF 记录以仅含 $$$$ 的行分隔。切分与拼装只动第一条记录，其余字节级保留。
const SEPARATOR = /^\s*\$\$\$\$\s*$/;

function newlineOf(content: string): string {
  const index = content.indexOf('\n');
  return index > 0 && content[index - 1] === '\r' ? '\r\n' : '\n';
}

export function splitSdfRecords(content: string): string[] {
  if (!content.trim()) return [];
  const newline = newlineOf(content);
  const records: string[] = [];
  let current: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    current.push(line);
    if (SEPARATOR.test(line)) {
      records.push(current.join(newline));
      current = [];
    }
  }
  if (current.length > 0) {
    if (current.join('').trim()) records.push(current.join(newline));
    // 尾换行切出的空行并回最后一条记录，拼装时字节一致
    else if (records.length > 0) records[records.length - 1] += newline.repeat(current.length);
  }
  return records;
}

// 幂等：已是 $$$$ 结尾的记录只规范化尾换行，否则追加分隔行。
export function ensureSdfRecord(text: string, newline = '\n'): string {
  const trimmed = text.replace(/(\r?\n|\s)*$/, '');
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > 0 && SEPARATOR.test(lines[lines.length - 1])) return `${trimmed}${newline}`;
  return `${trimmed}${newline}$$$$${newline}`;
}

export function replaceFirstSdfRecord(content: string, first: string): string {
  const records = splitSdfRecords(content);
  if (records.length <= 1) return ensureSdfRecord(first, newlineOf(content || first));
  return [ensureSdfRecord(first, newlineOf(content)), ...records.slice(1)].join('');
}
