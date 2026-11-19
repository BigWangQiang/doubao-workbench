import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { getRawHeader } from '@electron/asar';
import { NtExecutable, NtExecutableResource } from 'resedit';

function readIntegrityResource(executablePath) {
  const exe = NtExecutable.from(fs.readFileSync(executablePath), { ignoreCert: true });
  const resources = NtExecutableResource.from(exe);
  const entry = resources.entries.find(({ type, id }) =>
    String(type).toUpperCase() === 'INTEGRITY' && String(id).toUpperCase() === 'ELECTRONASAR');
  // Electron v33.4.11 archive_win.cc:52–56 缺少该资源会中止启动，打包时先拒绝此类产物。
  assert(entry, `Windows EXE 缺少 ASAR 完整性资源: ${executablePath}`);
  const records = JSON.parse(Buffer.from(entry.bin).toString('utf8'));
  return { exe, resources, entry, records };
}

function expectedIntegrity(asarPath) {
  const { headerString } = getRawHeader(asarPath);
  return [{ file: 'resources\\app.asar', alg: 'SHA256', value: createHash('sha256').update(headerString).digest('hex') }];
}

export function normalizeWindowsAsarIntegrity(executablePath, asarPath) {
  const { exe, resources, entry, records } = readIntegrityResource(executablePath);
  // electron-builder 25 用构建机的分隔符写入资源。Electron 33 在 Windows 直接按相对路径查表。
  const normalized = records.map((record) => ({ ...record, file: record.file.replaceAll('/', '\\') }));
  assert.deepEqual(normalized, expectedIntegrity(asarPath), `Windows EXE 的 ASAR 头摘要与文件不匹配: ${executablePath}`);
  if (records[0].file !== normalized[0].file) {
    entry.bin = new TextEncoder().encode(JSON.stringify(normalized)).buffer;
    resources.outputResource(exe);
    fs.writeFileSync(executablePath, Buffer.from(exe.generate()));
  }
}

export function verifyWindowsAsarIntegrity(executablePath, asarPath) {
  const { records } = readIntegrityResource(executablePath);
  assert.deepEqual(records, expectedIntegrity(asarPath), `Windows EXE 的 ASAR 路径或头摘要不匹配: ${executablePath}`);
}
