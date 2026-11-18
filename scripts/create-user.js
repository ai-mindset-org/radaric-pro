/**
 * Create a new user in the database
 *
 * Usage:
 *   node scripts/create-user.js <username> <password> [name] [--admin]
 *
 * Examples:
 *   node scripts/create-user.js john secretpass123 "John Doe"
 *   node scripts/create-user.js admin adminpass123 "Admin" --admin
 */

const bcrypt = require('bcryptjs')
const { PrismaClient } = require('@prisma/client')

async function createUser() {
  const args = process.argv.slice(2)

  // Check for --admin flag
  const isAdmin = args.includes('--admin')
  const filteredArgs = args.filter(arg => arg !== '--admin')

  if (filteredArgs.length < 2) {
    console.log('\n📝 Usage: node scripts/create-user.js <username> <password> [name] [--admin]\n')
    console.log('Examples:')
    console.log('  node scripts/create-user.js john secretpass123 "John Doe"')
    console.log('  node scripts/create-user.js admin adminpass123 "Admin" --admin')
    console.log('')
    process.exit(1)
  }

  const [username, password, name] = filteredArgs

  // Validate password
  if (password.length < 8) {
    console.error('\n❌ Error: Password must be at least 8 characters\n')
    process.exit(1)
  }

  // Validate username
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    console.error('\n❌ Error: Username can only contain letters, numbers, underscores and dashes\n')
    process.exit(1)
  }

  const prisma = new PrismaClient()

  try {
    // Check if username exists
    const existing = await prisma.user.findUnique({
      where: { username }
    })

    if (existing) {
      console.error(`\n❌ Error: User "${username}" already exists\n`)
      process.exit(1)
    }

    // RAD-285: the first account in an empty database becomes ADMIN on signup;
    // a CLI bootstrap should not silently create a USER-only first account.
    const userCount = await prisma.user.count()
    if (userCount === 0 && !isAdmin) {
      console.warn('\n⚠️  This is the first account in an empty database — signing up would make it ADMIN.')
      console.warn('   Re-run with --admin if this should be the operator account.\n')
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10)

    // Create user
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        name: name || username,
        role: isAdmin ? 'ADMIN' : 'USER',
        isActive: true,
      }
    })

    // Create empty user settings
    await prisma.userSettings.create({
      data: {
        userId: user.id,
      }
    })

    console.log('\n✅ User created successfully!')
    console.log('================================')
    console.log(`ID:       ${user.id}`)
    console.log(`Username: ${user.username}`)
    console.log(`Name:     ${user.name}`)
    console.log(`Role:     ${user.role}`)
    console.log('================================')
    console.log(`\n🔑 Login credentials:`)
    console.log(`   Username: ${username}`)
    console.log(`   Password: ${password}`)
    console.log('\n⚠️  Share these credentials with the user securely!\n')

  } catch (error) {
    console.error('\n❌ Failed to create user:', error.message)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

createUser()
