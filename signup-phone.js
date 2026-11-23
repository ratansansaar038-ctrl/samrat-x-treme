/* Samrat X-Treme: phone input validation and Appwrite's own SMS OTP verification. */
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
  async function beginPhoneVerification(account, password, input) {
    const phone = normalizeMobile(input);
    const current = await account.get();
    if (current.phone && current.phone !== phone && current.phoneVerification) {
      throw Error('This account already has a verified mobile number. Use LOGIN or contact support.');
    }
    if (current.phone !== phone) {
      await account.updatePhone({ phone, password });
    }
    const updated = await account.get();
    if (updated.phone !== phone) throw Error('Mobile number could not be saved to your account.');
    if (updated.phoneVerification === true) return { verified: true, phone };
    // The OTP is generated and delivered by Appwrite Cloud, not our website.
    await account.createPhoneVerification();
    return { verified: false, phone };
  }
  async function completePhoneVerification(account, secret) {
    const code = String(secret || '').trim();
    if (!/^\d{4,8}$/.test(code)) throw Error('Enter the OTP sent by Appwrite.');
    const user = await account.get();
    if (!user.phone) throw Error('Mobile number missing. Return to signup.');
    if (!user.phoneVerification) {
      await account.updatePhoneVerification({ userId: user.$id, secret: code });
    }
    const checked = await account.get();
    if (checked.phoneVerification !== true) {
      throw Error('Mobile OTP verification has not completed.');
    }
    return checked;
  }
  global.SamratPhone = { normalizeMobile, beginPhoneVerification, completePhoneVerification };
})(window);
