"use strict";

const {setGlobalOptions} = require("firebase-functions/v2");
const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

setGlobalOptions({maxInstances: 10});

const TOYYIBPAY_SECRET = process.env.TOYYIBPAY_SECRET;
const TOYYIBPAY_CATEGORY_CODE = process.env.TOYYIBPAY_CATEGORY_CODE;
const TOYYIBPAY_BASE_URL = process.env.TOYYIBPAY_BASE_URL || "https://toyyibpay.com";
const PAYMENT_RETURN_URL = process.env.PAYMENT_RETURN_URL;
const PAYMENT_CALLBACK_URL = process.env.PAYMENT_CALLBACK_URL;

function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

function parseFormBody(req) {
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length) {
    return req.body;
  }
  const raw = req.rawBody ? req.rawBody.toString() : "";
  if (!raw) return {};
  const params = new URLSearchParams(raw);
  const data = {};
  params.forEach((value, key) => {
    data[key] = value;
  });
  return data;
}

function parseSlotLabel(label) {
  if (!label) return null;
  const zoneMatch = /zone\s*(\d+)/i.exec(label);
  const garajMatch = /(?:garaj|garage)\s*(\d+)/i.exec(label);
  if (!zoneMatch || !garajMatch) return null;
  const zoneIndex = Number(zoneMatch[1]) - 1;
  const garajIndex = Number(garajMatch[1]) - 1;
  if (Number.isNaN(zoneIndex) || Number.isNaN(garajIndex)) return null;
  return {z: zoneIndex, g: garajIndex};
}

function findSlotByIc(zones, ic) {
  if (!Array.isArray(zones)) return null;
  for (let z = 0; z < zones.length; z += 1) {
    const garajList = Array.isArray(zones[z] && zones[z].garaj) ? zones[z].garaj : [];
    for (let g = 0; g < garajList.length; g += 1) {
      if (garajList[g] && garajList[g].ic === ic) {
        return {z, g};
      }
    }
  }
  return null;
}

exports.createToyyibBill = onRequest(async (req, res) => {
  try {
    setCors(res);
    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }
    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed");
    }

    const payload = req.body || {};
    const tenantIc = payload.ic;
    const tenantName = payload.name;
    const amount = Number(payload.amount || 0);
    const cleanAmount = Math.round(amount * 100) / 100;

    if (!tenantIc || !Number.isFinite(cleanAmount) || cleanAmount <= 0) {
      return res.status(400).json({error: "Invalid payload"});
    }
    if (!TOYYIBPAY_SECRET || !TOYYIBPAY_CATEGORY_CODE || !PAYMENT_RETURN_URL || !PAYMENT_CALLBACK_URL) {
      return res.status(500).json({error: "Missing payment config"});
    }

    const billName = `Bayaran Garaj - ${tenantName || tenantIc}`;
    const billAmount = Math.round(cleanAmount * 100);
    const body = new URLSearchParams({
      userSecretKey: TOYYIBPAY_SECRET,
      categoryCode: TOYYIBPAY_CATEGORY_CODE,
      billName,
      billDescription: `Bayaran garaj untuk ${tenantName || tenantIc}`,
      billPriceSetting: "1",
      billPayorInfo: "0",
      billAmount: String(billAmount),
      billReturnUrl: PAYMENT_RETURN_URL,
      billCallbackUrl: PAYMENT_CALLBACK_URL,
      billExternalReferenceNo: tenantIc,
    });

    const response = await fetch(`${TOYYIBPAY_BASE_URL}/index.php/api/createBill`, {
      method: "POST",
      body,
    });
    if (!response.ok) {
      logger.error("ToyyibPay API error", {status: response.status});
      return res.status(502).json({error: "ToyyibPay API error"});
    }

    const data = await response.json();
    const billCode = data && data[0] && data[0].BillCode ? data[0].BillCode : "";
    if (!billCode) {
      return res.status(502).json({error: "Missing BillCode from ToyyibPay"});
    }

    await admin.database().ref(`payments/${billCode}`).set({
      ic: tenantIc,
      amount: cleanAmount,
      status: "pending",
      createdAt: Date.now(),
    });

    return res.json({
      url: `${TOYYIBPAY_BASE_URL}/${billCode}`,
      billCode,
    });
  } catch (err) {
    logger.error("createToyyibBill failed", err);
    return res.status(500).json({error: "Internal error"});
  }
});

exports.toyyibpayCallback = onRequest(async (req, res) => {
  try {
    const payload = parseFormBody(req);
    const billCode = payload.billcode || payload.billCode || payload.bill_code;
    const statusRaw = String(payload.status_id || payload.status || payload.statusId || "");
    const statusText = statusRaw.toLowerCase();
    const isPaid = statusText === "1" || statusText === "paid" || statusText === "success";

    if (!billCode) {
      return res.status(400).send("Missing billcode");
    }

    const paymentRef = admin.database().ref(`payments/${billCode}`);
    const paymentSnap = await paymentRef.get();
    const payment = paymentSnap.exists() ? paymentSnap.val() : null;

    await paymentRef.update({
      status: isPaid ? "paid" : "failed",
      updatedAt: Date.now(),
      raw: payload,
    });

    if (isPaid && payment && payment.ic) {
      const tenantsSnap = await admin.database().ref("tenants").get();
      const tenants = tenantsSnap.val();
      if (Array.isArray(tenants)) {
        const idx = tenants.findIndex((tenant) => tenant && tenant.ic === payment.ic);
        if (idx >= 0) {
          const current = tenants[idx] || {};
          const currentBaki = Number(current.baki) || 0;
          const paidAmount = Number(payment.amount) || 0;
          const newBaki = Math.max(0, currentBaki - paidAmount);
          const newStatus = newBaki > 0 ? "Overdue" : "Paid";
          tenants[idx] = Object.assign({}, current, {baki: newBaki, status: newStatus});
          await admin.database().ref("tenants").set(tenants);

          const zonesSnap = await admin.database().ref("zones").get();
          const zones = zonesSnap.val();
          if (Array.isArray(zones)) {
            let slot = parseSlotLabel(current.garaj);
            if (!slot || !zones[slot.z] || !Array.isArray(zones[slot.z].garaj) || !zones[slot.z].garaj[slot.g]) {
              slot = findSlotByIc(zones, payment.ic);
            }
            if (slot && zones[slot.z] && Array.isArray(zones[slot.z].garaj) && zones[slot.z].garaj[slot.g]) {
              zones[slot.z].garaj[slot.g] = Object.assign({}, zones[slot.z].garaj[slot.g], {
                baki: newBaki,
                status: newStatus,
              });
              await admin.database().ref("zones").set(zones);
            }
          }
        }
      }
    }

    return res.status(200).send("ok");
  } catch (err) {
    logger.error("toyyibpayCallback failed", err);
    return res.status(500).send("error");
  }
});
