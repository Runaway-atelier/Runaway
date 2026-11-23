"use strict";
const form = document.getElementById('loginForm');
const button = document.getElementById('loginBtn');
const errorText = document.getElementById('loginErr');
form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  errorText.textContent = '';
  try {
    const response = await fetch('/api/admin-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('ownerEmail').value.trim(), password: document.getElementById('passcode').value }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to sign in.');
    sessionStorage.setItem('runaway_owner_session', 'active');
    window.location.replace('dashboard.html');
  } catch (error) { errorText.textContent = error.message || 'Unable to sign in.'; }
  finally { button.disabled = false; }
});
