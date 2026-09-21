// One-time bootstrap: create the first Complaint Reports admin.
// Team management (POST /complaint-reports/api/team) requires being an admin
// already, so the very first account has to be created directly against
// Supabase. Run from the report-deployer root:
//
//   node scripts/seed-cr-admin.js "Nikhil Chavda" nikhil@askolly.io "a-strong-password" admin
//
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const [name, email, password, role = 'admin'] = process.argv.slice(2);

  if (!name || !email || !password) {
    console.error('Usage: node scripts/seed-cr-admin.js "Full Name" email@askolly.io password [admin|member]');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error('Password needs at least 6 characters.');
    process.exit(1);
  }
  if (!['admin', 'member'].includes(role)) {
    console.error('Role must be "admin" or "member".');
    process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.');
    process.exit(1);
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const password_hash = await bcrypt.hash(password, 10);
  const { data, error } = await sb
    .from('complaint_report_users')
    .insert({ name, email: email.toLowerCase(), password_hash, role })
    .select('id, name, email, role')
    .single();

  if (error) {
    if (error.code === '23505') {
      console.error('Someone already uses that email.');
    } else {
      console.error('Could not create the account:', error.message);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Created:', data);
}

// process.exitCode (not process.exit()) lets Node drain pending sockets from
// the Supabase client on its own — calling exit() right after an awaited
// fetch can otherwise crash Node on Windows (UV_HANDLE_CLOSING assertion).
main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exitCode = 1;
});
