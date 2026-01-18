# Payment Gateway Setup (ToyyibPay)

This project supports two payment modes:
- Manual mode (no backend): opens a fixed payment link, admin updates status.
- Auto mode (backend): uses Cloud Functions to update `tenants` + `zones` automatically.

## 1) ToyyibPay account
- Create a category in ToyyibPay and copy the `Category Code`.
- Copy your `User Secret Key`.

## 2) Manual mode (no Blaze)
In `penyewa.html`, set:

```js
const PAYMENT_CONFIG = {
    mode: 'manual',
    provider: 'toyyibpay',
    paymentUrl: 'https://<your-payment-link>',
    createEndpoint: ''
};
```

Notes:
- `paymentUrl` can be a ToyyibPay link or any payment page you use.
- Status will be updated by admin (manual).

## 3) Auto mode (requires Blaze + Cloud Functions)
1. Copy `functions/.env.example` to `functions/.env` and fill the values.
2. Deploy the functions (example):

```bash
cd functions
npm install
firebase deploy --only functions
```

## 4) Update the frontend endpoint (auto mode)
In `penyewa.html`, set:

```js
const PAYMENT_CONFIG = {
    mode: 'auto',
    provider: 'toyyibpay',
    paymentUrl: '',
    createEndpoint: 'https://<your-cloud-function-url>/createToyyibBill'
};
```

## Notes
- Auto mode needs Blaze billing enabled to deploy functions.
- The callback URL should point to `toyyibpayCallback`.
- The return URL should point to `penyewa.html` so the user comes back after payment.
