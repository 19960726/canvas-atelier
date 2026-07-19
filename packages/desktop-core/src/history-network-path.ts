import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

export interface HistoryNetworkPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly probeDriveType?: (driveRoot: string) => Promise<string>;
}

export async function isHistoryNetworkPath(
  path: string,
  options: HistoryNetworkPathOptions = {},
): Promise<boolean> {
  if (/^[/\\]{2}/u.test(path)) return true;
  if ((options.platform ?? process.platform) !== 'win32') return false;
  const driveRoot = win32.parse(win32.resolve(path)).root.replace(/[\\/]+$/u, '');
  if (!/^[A-Za-z]:$/u.test(driveRoot)) return true;
  let output: string;
  try {
    output = await (options.probeDriveType ?? probeWindowsDriveType)(driveRoot);
  } catch {
    return true;
  }
  if (/remote|network|远程|网络/iu.test(output)) return true;
  if (/fixed|removable|cd-rom|ram disk|固定|可移动|光盘|磁盘/iu.test(output)) return false;
  return true;
}

function probeWindowsDriveType(driveRoot: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'fsutil.exe',
      ['fsinfo', 'drivetype', driveRoot],
      { encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}
