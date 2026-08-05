/** 转义正则元字符（权限通配符转 RegExp 与 glob 转 RegExp 共用） */
export function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
