import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const platforms = {
  'aarch64-apple-darwin': 'macos-arm64.zip',
  'x86_64-pc-windows-msvc': 'windows-x64-setup.exe',
};

// Validate the complete pair before preparing any files for publication. Artifacts
// remain in separate directories so their build-info.json files cannot overwrite.
export async function prepareRelease({ artifactsDir, outputDir, version, tag, commit }) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  assert.equal(tag, 'v' + version, 'Release tag must match the root package.json version');
  assert.match(commit, /^[a-f0-9]{40}$/, 'Expected the tested commit SHA');
  const files = new Map();
  for (const [target, suffix] of Object.entries(platforms)) {
    const source = join(artifactsDir, `Roost-${version}-${target}`);
    const metadata = await readFile(join(source, 'build-info.json'));
    const info = JSON.parse(metadata);
    assert.equal(info.version, version, 'Artifact version mismatch');
    assert.equal(info.target, target, 'Artifact target mismatch');
    assert.equal(info.commit, commit, 'Artifact commit mismatch');
    const name = `Roost-${version}-${suffix}`;
    const binary = await readFile(join(source, name));
    const checksum = await readFile(join(source, name + '.sha256'), 'utf8');
    assert.equal(checksum.trim(), `${createHash('sha256').update(binary).digest('hex')}  ${name}`, 'Artifact checksum mismatch');
    files.set(name, binary);
    files.set(name + '.sha256', checksum);
    files.set(`Roost-${version}-${target}-build-info.json`, metadata);
  }
  // Refuse an existing output directory, including leftovers from a failed run.
  await mkdir(outputDir);
  for (const [name, contents] of files) await writeFile(join(outputDir, name), contents);
  const notes = `Roost ${tag} 桌面预览版\n\n` +
    '- Windows x64：下载 windows-x64-setup.exe 安装。\n' +
    '- macOS Apple Silicon（macOS 15+）：解压 macos-arm64.zip，将 Roost.app 放入 Applications。\n' +
    '- 两端随包携带 Node，桌面工作区免密码进入；AI CLI 需自行安装。\n' +
    '- 附带 SHA-256 校验文件及各平台构建信息。\n\n' +
    'Mac 使用 ad-hoc 签名，尚未公证；Windows 尚无发行者签名。真实输入法及完整 CLI 对话仍待人工验收。\n\n' +
    `构建提交：\`${commit}\`。两端构建和运行包测试通过，Windows 另外通过实际 WebView2 窗口的新建终端和刷新检查。\n`;
  await writeFile(join(dirname(outputDir), 'release-notes.md'), notes);
  return [...files.keys()];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [artifactsDir, outputDir] = process.argv.slice(2);
  assert.ok(artifactsDir && outputDir, 'Expected artifact and release output directories');
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const files = await prepareRelease({ artifactsDir, outputDir, version,
    tag: process.env.GITHUB_REF_NAME, commit: process.env.GITHUB_SHA });
  console.log(`Verified ${version}: ${files.length} release assets`);
}
