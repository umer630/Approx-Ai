// Starts the real backend (with the Supabase test double) for the Android Robolectric end-to-end test and prints
// {"base","token","email","password"} for a fresh signed-in account on the first line. Runs until killed.
process.env.APPROX_TEST_KEEPALIVE = '1';
const { makeUser, BASE } = await import('./helpers.js');
const u = await makeUser();
console.log(JSON.stringify({ base: BASE, token: u.token, email: u.email, password: u.password }));
setInterval(() => {}, 1 << 30);
