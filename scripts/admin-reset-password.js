#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const { createClient } = require("@supabase/supabase-js")

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return {}
  }

  const entries = {}
  const content = fs.readFileSync(filePath, "utf8")

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }

    const equalsAt = trimmed.indexOf("=")
    if (equalsAt <= 0) {
      continue
    }

    const key = trimmed.slice(0, equalsAt).trim()
    let value = trimmed.slice(equalsAt + 1).trim()

    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    }

    if (key && !(key in entries)) {
      entries[key] = value
    }
  }

  return entries
}

function loadAdminEnv() {
  const env = { ...process.env }
  const source = parseDotEnv(path.resolve(process.cwd(), ".env.admin"))
  const fallback = parseDotEnv(path.resolve(process.cwd(), ".env"))

  for (const [key, value] of Object.entries(source)) {
    if (env[key] === undefined) {
      env[key] = value
    }
  }

  for (const [key, value] of Object.entries(fallback)) {
    if (env[key] === undefined) {
      env[key] = value
    }
  }

  return env
}

function printUsage() {
  console.log("Usage:")
  console.log("  node scripts/admin-reset-password.js --email user@example.com --password NewPassword123")
  console.log("  node scripts/admin-reset-password.js --user-id uuid --password NewPassword123")
  console.log("")
  console.log("Options:")
  console.log("  --email         User email address")
  console.log("  --user-id       Supabase auth user UUID")
  console.log("  --password      New password (min 6 chars)")
  console.log("  --url           Optional Supabase URL override")
  console.log("  --service-key   Optional service role key override")
  console.log("  --dry-run       Resolve user only; don't update password")
}

function parseArgs() {
  const args = process.argv.slice(2)
  const values = { dryRun: false }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === "--help" || arg === "-h") {
      printUsage()
      process.exit(0)
    }

    if (arg === "--dry-run") {
      values.dryRun = true
      continue
    }

    if (arg.startsWith("--")) {
      const key = arg.replace(/^--/, "")
      const value = args[index + 1]
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for --${key}`)
      }
      index += 1
      if (key === "email") {
        values.email = value
      } else if (key === "user-id") {
        values.userId = value
      } else if (key === "password") {
        values.password = value
      } else if (key === "url") {
        values.url = value
      } else if (key === "service-key") {
        values.serviceRoleKey = value
      } else {
        throw new Error(`Unknown option: --${key}`)
      }
    }
  }

  return values
}

async function findUserByEmail(authAdmin, normalizedEmail) {
  let page = 1
  const perPage = 1000

  while (true) {
    const { data, error } = await authAdmin.listUsers({ page, perPage })
    if (error) {
      throw new Error(`Failed to list users: ${error.message}`)
    }

    const users = data?.users || []
    const user = users.find((candidate) => String(candidate.email || "").trim().toLowerCase() === normalizedEmail)

    if (user) {
      return user
    }

    if (users.length < perPage) {
      return null
    }

    page += 1
  }
}

function ensureMinimumSecurity(password) {
  if (!password || password.length < 6) {
    throw new Error("Password must be at least 6 characters.")
  }
}

async function main() {
  const args = parseArgs()
  const env = loadAdminEnv()
  const supabaseUrl = args.url || env.SUPABASE_URL
  const serviceRoleKey = args.serviceRoleKey || env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
    console.error(
      "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.admin or pass --url/--service-key.",
    )
    process.exit(1)
  }

  if (!args.userId && !args.email) {
    console.error("Pass --email or --user-id.")
    printUsage()
    process.exit(1)
  }

  if (!args.password) {
    console.error("Pass --password.")
    printUsage()
    process.exit(1)
  }

  ensureMinimumSecurity(args.password)

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })

  const authAdmin = supabase.auth.admin
  let user = null

  if (args.userId) {
    const { data, error } = await authAdmin.getUserById(args.userId)
    if (error) {
      console.error(`Failed to load user by id: ${error.message}`)
      process.exit(1)
    }
    user = data.user
  } else {
    const normalizedEmail = args.email.trim().toLowerCase()
    user = await findUserByEmail(authAdmin, normalizedEmail)
    if (!user) {
      console.error(`No user found with email: ${args.email}`)
      process.exit(1)
    }
  }

  if (!user) {
    console.error("No matching user found.")
    process.exit(1)
  }

  console.log(`Found user: ${user.id} (${user.email})`)

  if (args.dryRun) {
    console.log("Dry run enabled; skipping password update.")
    process.exit(0)
  }

  const { error } = await authAdmin.updateUserById(user.id, {
    password: args.password,
    email_confirm: true,
  })

  if (error) {
    console.error(`Failed to update password: ${error.message}`)
    process.exit(1)
  }

  console.log(`Password updated for user ${user.id} (${user.email}).`)
}

main().catch((error) => {
  console.error(error?.message || "Unexpected error.")
  process.exit(1)
})
