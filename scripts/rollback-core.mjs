import { readlink, symlink, rename, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const root=resolve(process.env.CORE_INSTALL_DIR??join(homedir(),'.roost','core'));
const previous=await readlink(join(root,'previous'));
await access(join(root,previous,'core.mjs'));
const temp=join(root,'.rollback-'+randomUUID());await symlink(previous,temp);await rename(temp,join(root,'current'));
console.log('Selected previous core release. Restart only core-server to load it; daemon and PTYs are unaffected.');
