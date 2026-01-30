'use strict';

const loginForm = document.getElementById('loginForm');
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const errorMessage = document.getElementById('errorMessage');
const loginBtn = document.getElementById('loginBtn');

// Supabase client from supabase-init.js
const supabase2 = window.supabaseClient;

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  loginBtn.disabled = true;
  loginBtn.textContent = 'Logging in...';
  errorMessage.textContent = '';

  try {
    const { data, error } = await supabase2.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (error) {
      throw error;
    }

    // On success, redirect to the chat page
    if (data.session) {
      window.location.href = '/index.html';
    }
  } catch (err) {
    console.error('Login error:', err);
    errorMessage.textContent = err.message || 'Invalid email or password.';
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Login';
  }
});
