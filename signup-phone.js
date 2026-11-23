/* Samrat X-Treme signup mobile: India's +91 country code, not OTP verified. */
(function (global) {
  'use strict';
  function normalizeMobile(input) {
    let digits = String(input || '').replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (!/^[6-9]\d{9}$/.test(digits)) {
      throw Error('Enter a valid 10-digit Indian mobile number for signup.');
    }
    return '+91' + digits;
  }
  async function saveSignupMobile(account, password, input) {
    const phone = normalizeMobile(input);
    const current = await account.get();
    if (current.phone === phone) return phone;
    if (current.phone && current.phone !== phone) {
      throw Error('This account already has a different mobile number. Use LOGIN or contact support.');
    }
    // Appwrite stores the number on the signed-in Auth account; it does not send an OTP automatically.
    await account.updatePhone({ phone, password });
    return phone;
  }
  global.SamratPhone = { normalizeMobile, saveSignupMobile };
})(window);
