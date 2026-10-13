import type { AppCategory, StyleCategory } from '@shared/types'

const TERMINALS = new Set([
  'windowsterminal', 'cmd', 'powershell', 'pwsh', 'conhost', 'openconsole', 'warp', 'alacritty', 'hyper', 'kitty',
  'wezterm', 'wezterm-gui', 'mintty', 'tabby',
])

const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'zen', 'chromium', 'librewolf'])

const BY_PROCESS: Record<string, AppCategory> = {
  code: 'developer', 'code - insiders': 'developer', cursor: 'developer', windsurf: 'developer', zed: 'developer',
  devenv: 'developer', idea64: 'developer', pycharm64: 'developer', webstorm64: 'developer', rider64: 'developer',
  goland64: 'developer', clion64: 'developer', sublime_text: 'developer', 'notepad++': 'developer', nvim: 'developer',
  slack: 'work', teams: 'work', 'ms-teams': 'work', zoom: 'work', mattermost: 'work', lark: 'work',
  whatsapp: 'personal', telegram: 'personal', signal: 'personal', discord: 'personal', messenger: 'personal',
  line: 'personal', wechat: 'personal',
  outlook: 'email', olk: 'email', hxoutlook: 'email', thunderbird: 'email', mailspring: 'email', superhuman: 'email',
  chatgpt: 'chatbot', claude: 'chatbot', copilot: 'chatbot', perplexity: 'chatbot',
}

// Browser tabs are classified by the page title, which is all the helper can see.
const BY_TITLE: Array<[RegExp, AppCategory]> = [
  [/\b(gmail|outlook|proton mail|fastmail|yahoo mail|hey\.com)\b|\bmail\b.*-|inbox \(/i, 'email'],
  [/\b(slack|microsoft teams|google chat|mattermost)\b/i, 'work'],
  [/\b(whatsapp|messenger|telegram|discord|instagram|signal)\b/i, 'personal'],
  [/\b(chatgpt|claude|gemini|perplexity|copilot|le chat|deepseek|grok)\b/i, 'chatbot'],
  [/\b(github|gitlab|stack overflow|codesandbox|replit)\b/i, 'developer'],
]

export function normalizeProcess(process: string): string {
  return process.toLowerCase().replace(/\.exe$/, '')
}

export function isTerminal(process: string): boolean {
  return TERMINALS.has(normalizeProcess(process))
}

export function categorizeApp(process: string, title: string): AppCategory {
  const name = normalizeProcess(process)
  if (TERMINALS.has(name)) return 'developer'
  const direct = BY_PROCESS[name]
  if (direct) return direct
  if (BROWSERS.has(name)) {
    for (const [pattern, category] of BY_TITLE) {
      if (pattern.test(title)) return category
    }
  }
  return 'other'
}

export function styleCategoryFor(category: AppCategory): StyleCategory {
  return category === 'personal' || category === 'work' || category === 'email' ? category : 'other'
}
