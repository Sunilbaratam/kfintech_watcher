// watch.mjs
//
// Loads the KFintech IPO status page in a headless browser, captures whatever
// gets printed to the browser console, pulls out a company-name -> client_id
// mapping from it, and diffs that against the last saved snapshot so you can
// see exactly what's new.
//
// Usage:
//   npm install
//   npm run check
//
// Optional env vars:
//   TARGET_URL           - defaults to https://ipostatus.kfintech.com/
//   WEBHOOK_URL           - if set, POSTs a JSON payload of new/changed entries here (e.g. a Slack incoming webhook)
//   HEADLESS              - "false" to watch it run in a visible browser window while debugging

import { chromium } from 'playwright'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

const TARGET_URL = process.env.TARGET_URL || 'https://ipostatus.kfintech.com/'
const HEADLESS = process.env.HEADLESS !== 'false'
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''

const DATA_DIR = path.resolve('data')
const MAP_FILE = path.join(DATA_DIR, 'client-id-map.json')
const HISTORY_DIR = path.join(DATA_DIR, 'history')

// ---------- helpers to recognise a company/client_id mapping in arbitrary console output ----------

const CLIENT_ID_KEY_RE = /^client[_-]?id$/i
const COMPANY_KEY_RE = /^(company|company_name|name|issuer|issue_name)$/i

function looksLikeClientId(v) {
  if (typeof v === 'number') return Number.isInteger(v)
  if (typeof v === 'string') return /^\d{5,}$/.test(v.trim())
  return false
}

function looksLikeCompanyName(v) {
  return typeof v === 'string' && v.trim().length >= 2 && !/^\d+$/.test(v.trim())
}

// Recursively walk any JS value pulled from the console and collect {company, clientId} pairs.
function extractPairs(value, out, seen = new Set()) {
  if (value === null || value === undefined || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    // Array of objects, each representing one company -> client_id entry
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const keys = Object.keys(item)
        const companyKey = keys.find(k => COMPANY_KEY_RE.test(k))
        const idKey = keys.find(k => CLIENT_ID_KEY_RE.test(k))
        if (companyKey && idKey && looksLikeCompanyName(item[companyKey]) && looksLikeClientId(item[idKey])) {
          out.push({ company: String(item[companyKey]).trim(), clientId: String(item[idKey]).trim() })
          continue
        }
      }
      extractPairs(item, out, seen)
    }
    return
  }

  // Plain object: could itself be a direct { "Company Name": "12345", ... } map
  const entries = Object.entries(value)
  const directPairs = entries.filter(([k, v]) => looksLikeCompanyName(k) && looksLikeClientId(v))
  if (directPairs.length > 0 && directPairs.length === entries.length) {
    for (const [k, v] of directPairs) {
      out.push({ company: k.trim(), clientId: String(v).trim() })
    }
    return
  }

  // Otherwise recurse into nested values
  for (const [, v] of entries) {
    if (v && typeof v === 'object') extractPairs(v, out, seen)
  }
}

// Fallback: scan raw console text for lines like "Some Company: 123456" or "Some Company - 123456"
function extractPairsFromText(text, out) {
  const re = /([A-Za-z][A-Za-z0-9 &.,'()\-]{2,80}?)\s*[:\-]\s*(\d{5,})/g
  let m
  while ((m = re.exec(text)) !== null) {
    out.push({ company: m[1].trim(), clientId: m[2].trim() })
  }
}

// ---------- main ----------

async function loadPreviousMap() {
  if (!existsSync(MAP_FILE)) return {}
  try {
    const raw = await readFile(MAP_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function saveMap(map) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(MAP_FILE, JSON.stringify(map, null, 2))
}

async function saveHistorySnapshot(map) {
  await mkdir(HISTORY_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await writeFile(path.join(HISTORY_DIR, `${stamp}.json`), JSON.stringify(map, null, 2))
}

async function notifyWebhook(added, changed) {
  if (!WEBHOOK_URL) return
  const lines = []
  for (const [company, clientId] of Object.entries(added)) {
    lines.push(`+ New: ${company} -> ${clientId}`)
  }
  for (const [company, { from, to }] of Object.entries(changed)) {
    lines.push(`~ Changed: ${company} (${from} -> ${to})`)
  }
  if (lines.length === 0) return
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `KFintech client_id watcher — updates:\n${lines.join('\n')}` }),
    })
  } catch (e) {
    console.error('Webhook notification failed:', e.message)
  }
}

async function main() {
  const collectedValues = []
  const collectedTexts = []

  console.log(`Launching browser and opening ${TARGET_URL} ...`)
  const browser = await chromium.launch({ headless: HEADLESS })
  const page = await browser.newPage()

  page.on('console', async (msg) => {
    collectedTexts.push(msg.text())
    for (const arg of msg.args()) {
      try {
        const val = await arg.jsonValue()
        collectedValues.push(val)
      } catch {
        // not JSON-serialisable (e.g. a DOM node or function) — ignore
      }
    }
  })

  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 })
  // Give any deferred logging a moment to fire after network-idle.
  await page.waitForTimeout(3000)

  await browser.close()

  const pairs = []
  for (const val of collectedValues) extractPairs(val, pairs)
  if (pairs.length === 0) {
    // Fall back to regex scanning of raw text if nothing structured was found
    for (const text of collectedTexts) extractPairsFromText(text, pairs)
  }

  if (pairs.length === 0) {
    console.warn('No company/client_id pairs recognised in this run\'s console output.')
    console.warn('Re-run with HEADLESS=false to watch it load and see what is actually being logged,')
    console.warn('or inspect the raw captured text below to tune the extraction patterns in watch.mjs:')
    console.warn(JSON.stringify(collectedTexts.slice(0, 20), null, 2))
    process.exit(1)
  }

  const currentMap = {}
  for (const { company, clientId } of pairs) {
    currentMap[company] = clientId
  }

  const previousMap = await loadPreviousMap()

  const added = {}
  const changed = {}
  for (const [company, clientId] of Object.entries(currentMap)) {
    if (!(company in previousMap)) {
      added[company] = clientId
    } else if (previousMap[company] !== clientId) {
      changed[company] = { from: previousMap[company], to: clientId }
    }
  }

  const addedCount = Object.keys(added).length
  const changedCount = Object.keys(changed).length

  console.log(`Captured ${Object.keys(currentMap).length} company/client_id pairs this run.`)
  if (addedCount === 0 && changedCount === 0) {
    console.log('No new or changed entries since the last run.')
  } else {
    if (addedCount > 0) {
      console.log(`\n${addedCount} new entr${addedCount === 1 ? 'y' : 'ies'}:`)
      for (const [company, clientId] of Object.entries(added)) {
        console.log(`  + ${company}: ${clientId}`)
      }
    }
    if (changedCount > 0) {
      console.log(`\n${changedCount} changed entr${changedCount === 1 ? 'y' : 'ies'}:`)
      for (const [company, { from, to }] of Object.entries(changed)) {
        console.log(`  ~ ${company}: ${from} -> ${to}`)
      }
    }
  }

  await saveMap(currentMap)
  await saveHistorySnapshot(currentMap)
  await notifyWebhook(added, changed)
}

main().catch(err => {
  console.error('Watcher run failed:', err)
  process.exit(1)
})
