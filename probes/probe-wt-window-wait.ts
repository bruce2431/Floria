// 探针：验证 cli.tsx 自举后「等待用户真能看到 WT 窗口」的判据可行——
// bun:ffi 直调 user32 FindWindowW(CASCADIA_HOSTING_WINDOW_CLASS, null) + IsWindowVisible。
// 期望：现存 WT 窗口时 hwnd 非 0 且 visible=true；不存在的类名对照组返回 0（NULL）。
import { FFIType, dlopen, ptr } from 'bun:ffi'

const user32 = dlopen('user32.dll', {
  FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.bool },
})

const find = (className: string): number => {
  const buf = Buffer.from(`${className}\0`, 'utf16le')
  return Number(user32.symbols.FindWindowW(ptr(buf), null))
}

const hwnd = find('CASCADIA_HOSTING_WINDOW_CLASS')
const visible = hwnd ? user32.symbols.IsWindowVisible(hwnd) : false
const bogus = find('NO_SUCH_WINDOW_CLASS_XYZ')

console.log(`WT window hwnd = ${hwnd} (${hwnd ? 'FOUND' : 'not found'}), visible = ${visible}`)
console.log(`control (bogus class) hwnd = ${bogus} (${bogus === 0 ? 'NULL as expected' : 'UNEXPECTED'})`)

const ok = hwnd > 0 && visible === true && bogus === 0
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
