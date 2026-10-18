import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { createTvPairingRouter } from "../src/routes/tvPairing.js";

function fixture() {
  const rows: any[] = [];
  let issued = 0;
  const database: any = {
    auth: {
      getUser: async (token: string) => ({
        data: {
          user:
            ["valid-session", "unverified-session"].includes(token)
              ? { id: "user-fixture", email: "fixture@example.test", email_confirmed_at: token === "valid-session" ? "2026-10-01T00:00:00Z" : null }
              : null,
        },
        error: ["valid-session", "unverified-session"].includes(token) ? null : {},
      }),
      admin: {
        generateLink: async () => {
          issued++;
          return {
            data: {
              properties: {
                hashed_token: "single-use-login-fixture",
                verification_type: "magiclink",
              },
            },
            error: null,
          };
        },
      },
    },
    rpc: async (_name: string, params: any) => {
      const row = rows.find(
        (row) =>
          row.pin_hash === params.p_pin_hash &&
          row.status === "pending" &&
          row.attempts < 10 &&
          Date.parse(row.expires_at) > Date.now()
      );
      if (row) row.attempts++;
      return { data: row ? [{ ...row }] : [], error: null };
    },
    from() {
      let action = "select",
        payload: any;
      const filters: Array<(row: any) => boolean> = [];
      const execute = () => {
        if (action === "insert") {
          rows.push({ status: "pending", attempts: 0, ...payload });
          return { data: null, error: null };
        }
        const selected = rows.filter((row) =>
          filters.every((filter) => filter(row))
        );
        if (action === "update")
          selected.forEach((row) => Object.assign(row, payload));
        if (action === "delete")
          selected.forEach((row) => rows.splice(rows.indexOf(row), 1));
        return { data: selected.map((row) => ({ ...row })), error: null };
      };
      const q: any = {
        select: () => q,
        insert: (value: any) => {
          action = "insert";
          payload = value;
          return q;
        },
        update: (value: any) => {
          action = "update";
          payload = value;
          return q;
        },
        delete: () => {
          action = "delete";
          return q;
        },
        eq: (key: string, value: any) => {
          filters.push((row) => row[key] === value);
          return q;
        },
        gt: (key: string, value: any) => {
          filters.push((row) => row[key] > value);
          return q;
        },
        lt: (key: string, value: any) => {
          filters.push((row) => row[key] < value);
          return q;
        },
        maybeSingle: async () => {
          const result = execute();
          return { ...result, data: result.data?.[0] || null };
        },
        then: (resolve: any, reject: any) =>
          Promise.resolve(execute()).then(resolve, reject),
      };
      return q;
    },
  };
  const router = createTvPairingRouter(
    () => database,
    () => async (_c, next) => {
      await next();
    }
  );
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const request = (operation: string, body: unknown, token?: string) =>
    router.request(`/${operation}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const create = async () => {
    const response = await request("create", {
      publicKey: keys.publicKey.export({ format: "jwk" }),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<any>;
  };
  return { request, create, rows, keys, issued: () => issued };
}

test("PIN cannot retrieve credentials; approval requires a verified session and matching phrase", async () => {
  const f = fixture(),
    created = await f.create();
  assert.match(created.pin, /^\d{6}$/);
  assert.ok(created.pollSecret.length >= 40);
  assert.equal(JSON.stringify(f.rows).includes(created.pollSecret), false);
  assert.equal(f.rows[0].pin_hash.includes(created.pin), false);
  assert.equal((await f.request("lookup", { pin: created.pin })).status, 401);
  const lookup = await f.request(
    "lookup",
    { pin: created.pin },
    "valid-session"
  );
  assert.equal(lookup.status, 200);
  assert.equal("pollSecret" in (await lookup.json()), false);
  const payload = {
    key: "sealed-key",
    iv: "sealed-iv",
    ciphertext: "sealed-credentials",
  };
  assert.equal(
    (
      await f.request("approve", {
        id: created.id,
        phrase: created.phrase,
        payload,
      })
    ).status,
    401
  );
  assert.equal(
    (
      await f.request(
        "approve",
        { id: created.id, phrase: "WRONG", payload },
        "valid-session"
      )
    ).status,
    409
  );
  assert.equal(f.issued(), 0);
  assert.equal((await f.request("approve", { id: created.id, phrase: created.phrase, payload }, "unverified-session")).status, 403);
  assert.equal(f.issued(), 0);
});
test("approval is atomic, login is encrypted to the originating TV, poll retry is stable, acknowledgement removes payload", async () => {
  const f = fixture(),
    created = await f.create();
  const payload = {
    key: "sealed-key",
    iv: "sealed-iv",
    ciphertext: "sealed-credentials",
  };
  const body = { id: created.id, phrase: created.phrase, payload };
  const responses = await Promise.all([
    f.request("approve", body, "valid-session"),
    f.request("approve", body, "valid-session"),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409]
  );
  assert.equal(f.issued(), 1);
  const tv = { id: created.id, pollSecret: created.pollSecret };
  assert.equal(
    (await f.request("poll", { ...tv, pollSecret: "x".repeat(43) })).status,
    410
  );
  const first: any = await (await f.request("poll", tv)).json(),
    second = await (await f.request("poll", tv)).json();
  assert.deepEqual(first, second);
  assert.equal(
    JSON.stringify(first).includes("single-use-login-fixture"),
    false
  );
  const login = JSON.parse(
    privateDecrypt(
      {
        key: f.keys.privateKey,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(first.payload.login, "base64")
    ).toString()
  );
  assert.equal(login.tokenHash, "single-use-login-fixture");
  assert.equal(login.type, "magiclink");
  assert.equal((await f.request("acknowledge", tv)).status, 200);
  assert.equal((await f.request("acknowledge", tv)).status, 200);
  const consumed: any = await (await f.request("poll", tv)).json();
  assert.equal(consumed.status, "consumed");
  assert.equal(consumed.payload, undefined);
  assert.equal((await f.request("cancel", tv)).status, 200);
  assert.equal(
    ((await (await f.request("poll", tv)).json()) as any).status,
    "consumed"
  );
});
test("expired, cancelled and repeatedly guessed codes cannot be approved", async () => {
  const f = fixture(),
    created = await f.create();
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await f.request("lookup", { pin: created.pin }, "valid-session")).status,
      200
    );
  assert.equal(
    (await f.request("lookup", { pin: created.pin }, "valid-session")).status,
    404
  );
  await f.request("cancel", { id: created.id, pollSecret: created.pollSecret });
  assert.equal(
    (
      await f.request(
        "approve",
        {
          id: created.id,
          phrase: created.phrase,
          payload: { key: "key", iv: "iv", ciphertext: "ciphertext" },
        },
        "valid-session"
      )
    ).status,
    409
  );
  const next = await f.create();
  f.rows.find((row) => row.id === next.id).expires_at = new Date(
    Date.now() - 1
  ).toISOString();
  assert.equal(
    (await f.request("poll", { id: next.id, pollSecret: next.pollSecret }))
      .status,
    410
  );
});
