/* Samrat X-Treme: Appwrite stores the phone; APITxT delivers SMS from the server Function. */
(function (global) {
  'use strict';
  const WALLET_FUNCTION_ID = '6ae1bcc500208a5a7efb';

  function normalizeMobile(input) {
    let digits = String(input || '').replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (!/^[6-9]\d{9}$/.test(digits)) {
      throw Error('Enter a valid 10-digit Indian mobile number for signup.');
    }
    return '+91' + digits;
  }

  async function otpApi(functions, action, extra = {}) {
    const execution = await functions.createExecution({
      functionId: WALLET_FUNCTION_ID,
      body: JSON.stringify({ action, ...extra }),
      async: false
    });
    let result;
    try { result = JSON.parse(execution.responseBody || '{}'); }
    catch { throw Error('Invalid OTP service response'); }
    if (execution.responseStatusCode !== 200 || result.ok !== true) {
      throw Error(result.error || 'OTP service unavailable. Contact support.');
    }
    return result;
  }

  async function beginPhoneVerification(account, functions, password, input) {
    const phone = normalizeMobile(input);
    const current = await account.get();
    if (current.phone && current.phone !== phone) {
      const status = await otpApi(functions, 'sms_otp_status').catch(() => ({verified: false}));
      if (status.verified) throw Error('This account already has a verified mobile number. Use LOGIN or contact support.');
    }
    if (current.phone !== phone) {
      await account.updatePhone({ phone, password });
    }
    const updated = await account.get();
    if (updated.phone !== phone) throw Error('Mobile number could not be saved.');
    return otpApi(functions, 'start_sms_otp');
  }

  async function completePhoneVerification(account, functions, code) {
    if (!/^\d{6}$/.test(String(code || '').trim()))
      throw Error('Enter the 6-digit SMS OTP.');
    const user = await account.get();
    if (!user.phone) throw Error('Mobile number missing. Return to signup.');
    return otpApi(functions, 'verify_sms_otp', {otp: String(code).trim()});
  }

  async function getPhoneOtpStatus(functions) {
    return otpApi(functions, 'sms_otp_status');
  }

  global.SamratPhone = {
    normalizeMobile, beginPhoneVerification, completePhoneVerification, getPhoneOtpStatus
  };
})(window);
