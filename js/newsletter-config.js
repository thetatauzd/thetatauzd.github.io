/**
 * Newsletter email list config. Read by the public Newsletters page (js/newsletter-signup.js)
 * and by the portal's Newsletters admin page ("Email subscribers").
 *
 * NEWSLETTER_GATEWAY_URL is the /exec URL of the newsletter Apps Script web app, which keeps
 * the sign-up list in a chapter Google Sheet and is owned by the chapter Gmail
 * (see portal/apps-script/README.md). No email addresses live here, in Firebase or in the repo.
 *
 * Leave it '' until the script is deployed. While it is '':
 * - newsletter.html shows "Email sotheta@mailbox.sc.edu to get on the list" instead of the form.
 * - the portal's "Email subscribers" button says the script is not deployed yet.
 *
 * After changing this file, bump ?v= wherever it is loaded:
 * newsletter.html (/js/newsletter-config.js?v=N) and portal/newsletters-admin.html (../js/newsletter-config.js?v=N).
 */
window.NEWSLETTER_GATEWAY_URL = 'https://script.google.com/macros/s/AKfycbxjnEt3Yr9yB7k6Kug6VaYvYjHA2XcGFefZPOtWia-G2Su3E3FchEwa5phu_SyG5Gbz/exec';
