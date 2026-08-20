/** 编译问题（错误/警告），全部携带 文件:行:列。 */

export interface CompileIssue {
  file: string;
  line: number;
  col: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface IssueSink {
  error(file: string, line: number, col: number, message: string): void;
  warning(file: string, line: number, col: number, message: string): void;
}

export function formatIssue(i: CompileIssue): string {
  return `${i.file}:${i.line}:${i.col} ${i.severity === 'error' ? '错误' : '警告'}：${i.message}`;
}
