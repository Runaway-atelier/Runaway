"use strict";

const form = document.getElementById('loginForm');
const button = document.getElementById('loginBtn');
const errorText = document.getElementById('loginErr');
const input = document.getElementById('secretKey');

form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  errorText.textContent = '';
  let val = input.value.trim().replace(/^ADMIN_SECRET_KEY\s*=\s*/, '').trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1).trim();
  if (window.location.protocol === 'file:') {
    errorText.textContent = 'Open http://localhost:3000/admin/login to sign in.';
    button.disabled = false;
    return;
  }
  if (val.length < 32) {
    errorText.textContent = 'Paste the full current owner passcode (at least 32 characters). The old sample passcode is no longer accepted.';
    button.disabled = false;
    return;
  }

  try {
    const response = await fetch('/api/admin-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secretKey: val }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Invalid secret key.');

    try {
      sessionStorage.setItem('runaway_owner_session', 'active');
      sessionStorage.setItem('runaway_owner_login_time', new Date().toISOString());
    } catch { /* The HttpOnly server cookie is the source of authentication. */ }
    window.location.replace('dashboard.html');
  } catch (error) {
    errorText.textContent = error.message || 'Unable to sign in.';
    input.value = '';
    input.focus();
    form.animate([
      { transform: 'translateX(-6px)' },
      { transform: 'translateX(6px)' },
      { transform: 'translateX(-4px)' },
      { transform: 'translateX(4px)' },
      { transform: 'translateX(0)' }
    ], { duration: 250, easing: 'ease-in-out' });
  } finally {
    button.disabled = false;
  }
});
