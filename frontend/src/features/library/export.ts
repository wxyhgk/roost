export function exportJson(name: string, value: unknown, raw = false) {
  const url = URL.createObjectURL(new Blob([raw ? String(value) : JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
