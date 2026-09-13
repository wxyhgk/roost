// One registry for build selection, native dependency filtering and support status.
// A platform config or a pinned Node archive does not make a target runnable.
export const targets = Object.freeze({
  'aarch64-apple-darwin': {
    platform: 'darwin', arch: 'arm64', status: 'preview', config: 'macos',
    archivePlatform: 'darwin', archiveExtension: 'tar.gz', nodePath: 'bin/node',
    entitlements: 'entitlements.plist',
    executables: ['node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'],
  },
  'x86_64-pc-windows-msvc': {
    platform: 'win32', arch: 'x64', status: 'preview', config: 'windows',
    archivePlatform: 'win', archiveExtension: 'zip', nodePath: 'node.exe', executables: [],
  },
  'x86_64-unknown-linux-gnu': {
    platform: 'linux', arch: 'x64', status: 'planned', config: 'linux',
    archivePlatform: 'linux', archiveExtension: 'tar.gz', nodePath: 'bin/node', executables: [],
    reason: 'Linux still needs native launcher, WebKitGTK session bootstrap and distribution/runtime validation.',
  },
});

export function resolveTarget(requested, host = process) {
  const triple = requested ?? Object.keys(targets).find(key => targets[key].platform === host.platform && targets[key].arch === host.arch);
  const target = Object.hasOwn(targets, triple) ? targets[triple] : undefined;
  if (!target) throw Error(`Unknown desktop target: ${requested ?? `${host.platform}-${host.arch}`}. Run npm run desktop:targets.`);
  const extension = target.platform === 'win32' ? '.exe' : '';
  return { ...target, triple, nodeExecutable: `node${extension}`, sidecar: `roost-node-${triple}${extension}`,
    prebuild: `${target.platform}-${target.arch}` };
}

export function assertBuildable(target, host = process) {
  if (target.status !== 'preview') throw Error(`${target.triple} is planned, not ready to build. ${target.reason}`);
  if (target.platform !== host.platform || target.arch !== host.arch)
    throw Error(`Build ${target.triple} on a matching ${target.platform}-${target.arch} host; installed native dependencies cannot be cross-packaged.`);
}

export function runtimeForTarget(lock, target) {
  const runtime = lock.targets?.[target.triple];
  const archive = `node-${lock.nodeVersion}-${target.archivePlatform}-${target.arch}.${target.archiveExtension}`;
  if (!/^v\d+\.\d+\.\d+$/.test(lock.nodeVersion) || runtime?.archive !== archive || !/^[a-f0-9]{64}$/.test(runtime?.sha256 ?? ''))
    throw Error(`Missing or invalid pinned Node runtime for ${target.triple}`);
  return { ...runtime, nodeVersion: lock.nodeVersion };
}

function matches(values, actual) {
  if (!values) return true;
  if (values.includes('!' + actual)) return false;
  const allowed = values.filter(value => !value.startsWith('!'));
  return allowed.length === 0 || allowed.includes(actual) || allowed.includes('any');
}

export function supportsTarget(pkg, target) {
  return matches(pkg.os, target.platform) && matches(pkg.cpu, target.arch);
}

export function parseOptions(args) {
  const options = { skipFrontend: false, target: undefined };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--skip-frontend') options.skipFrontend = true;
    else if (arg === '--target' || arg.startsWith('--target=')) {
      const value = arg === '--target' ? args[++i] : arg.slice('--target='.length);
      if (!value || value.startsWith('-') || options.target) throw Error('Provide exactly one --target <target-triple>.');
      options.target = value;
    } else throw Error(`Unknown desktop option: ${arg}`);
  }
  return options;
}
