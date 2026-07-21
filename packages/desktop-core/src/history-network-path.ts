import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { TextDecoder } from 'node:util';

export interface HistoryNetworkPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly probeDriveType?: (driveRoot: string) => Promise<string | Uint8Array>;
}

export async function isHistoryNetworkPath(
  path: string,
  options: HistoryNetworkPathOptions = {},
): Promise<boolean> {
  if (/^[/\\]{2}/u.test(path)) return true;
  if ((options.platform ?? process.platform) !== 'win32') return false;
  const driveRoot = win32.parse(win32.resolve(path)).root.replace(/[\\/]+$/u, '');
  if (!/^[A-Za-z]:$/u.test(driveRoot)) return true;
  let rawOutput: string | Uint8Array;
  try {
    rawOutput = await (options.probeDriveType ?? probeWindowsDriveType)(driveRoot);
  } catch {
    return true;
  }
  const outputs = decodeDriveTypeOutputs(rawOutput);
  if (outputs.some((output) => /remote|network|远程|网络/iu.test(output))) return true;
  if (outputs.some((output) => /fixed|removable|cd-rom|ram disk|固定|可移动|光盘|磁盘/iu.test(output))) return false;
  return true;
}

function decodeDriveTypeOutputs(output: string | Uint8Array): string[] {
  if (typeof output === 'string') return [output];
  const bytes = Buffer.from(output);
  const decoded = [new TextDecoder('utf-8').decode(bytes)];
  try {
    decoded.push(new TextDecoder('gbk').decode(bytes));
  } catch {
    // Full ICU builds support GBK; UTF-8 and English output remain usable otherwise.
  }
  return decoded;
}

function probeWindowsDriveType(driveRoot: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    execFile(
      'fsutil.exe',
      ['fsinfo', 'drivetype', driveRoot],
      { encoding: 'buffer', windowsHide: true },
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
