package com.deepseek.harness;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;

import javax.crypto.Mac;
import javax.crypto.SecretKey;

/**
 * OriginSigner — подпись происхождения записей памяти ключом Android Keystore.
 *
 * Зачем: правило «человеческая запись важнее агентской» защищает только тогда, когда происхождение
 * нельзя подделать. Ключ HMAC живёт в Keystore, не экспортируется и недоступен ни одному процессу,
 * включая движок и агента: Node получает только пакетную ПРОВЕРКУ, подпись инициирует человек из UI.
 *
 * Каноническая форма записи: id, key, origin, supersedes, sha256(тело). Тело заменено хешем, поэтому
 * подмена текста при сохранённой подписи делает её невалидной.
 *
 * Fail-closed: любая ошибка (нет ключа, недоступен Keystore, битая подпись, вызов подписи без UI) —
 * результат «не подтверждено», то есть запись считается агентской.
 */
public final class OriginSigner {
    private static final String KEY_ALIAS = "dsh-origin-hmac-v1";
    private static final String MAC_ALGO = "HmacSHA256";
    private static final String KEYSTORE = "AndroidKeyStore";

    /** Окно, в котором разрешена подпись: открывает UI явным действием пользователя и закрывает сам. */
    private static volatile long uiArmedUntil = 0L;

    private OriginSigner() { }

    /** Вызывается ТОЛЬКО из UI-действия человека (кнопка «подписать текущее»). Держит окно 120 секунд. */
    public static void armFromUi() { uiArmedUntil = System.currentTimeMillis() + 120_000L; }

    public static void disarm() { uiArmedUntil = 0L; }

    public static boolean isArmed() { return System.currentTimeMillis() < uiArmedUntil; }

    /** Каноническая строка записи: id, key, origin, supersedes, sha256(тело). */
    public static String canonical(String id, String key, String origin, String supersedes, String body) {
        return String.valueOf(id == null ? "" : id) + "\n"
             + String.valueOf(key == null ? "" : key) + "\n"
             + String.valueOf(origin == null ? "" : origin) + "\n"
             + String.valueOf(supersedes == null ? "" : supersedes) + "\n"
             + sha256Hex(body == null ? "" : body);
    }

    public static String sha256Hex(String text) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] h = md.digest(String.valueOf(text).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(h.length * 2);
            for (byte b : h) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            android.security.keystore.KeyGenerator kg = android.security.keystore.KeyGenerator.getInstance(MAC_ALGO, KEYSTORE);
            KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                    .setKeySize(256)
                    .build();
            kg.init(spec);
            kg.generateKey();
        }
        return (SecretKey) ks.getKey(KEY_ALIAS, null);
    }

    private static String hmacBase64(String canonical) throws Exception {
        Mac mac = Mac.getInstance(MAC_ALGO);
        mac.init(key());
        return Base64.encodeToString(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
    }

    /** Подпись записи. Без активного UI-окна возвращает null: код агента подписывать не может. */
    public static String signFromUi(String canonical) {
        if (!isArmed()) return null;
        try { return hmacBase64(canonical); } catch (Exception e) { return null; }
    }

    /** Проверка подписи. Безопасна для вызова из движка: подделать по ней ничего нельзя. */
    public static boolean verify(String canonical, String signature) {
        if (canonical == null || signature == null || signature.isEmpty()) return false;
        try {
            byte[] expected = hmacBase64(canonical).getBytes(StandardCharsets.UTF_8);
            byte[] actual = signature.getBytes(StandardCharsets.UTF_8);
            return MessageDigest.isEqual(expected, actual);
        } catch (Exception e) {
            return false;   // нет ключа/канала — считаем неподтверждённым
        }
    }

    /**
     * Пакетная проверка для движка: {"records":[{"canonical":"...","signature":"..."}]}
     * Возвращает {"ok":true,"results":[true,false,...]} — по одному ответу на запись, в том же порядке.
     */
    public static String verifyBatchJson(String requestJson) {
        JSONObject out = new JSONObject();
        try {
            JSONObject in = new JSONObject(requestJson == null ? "{}" : requestJson);
            JSONArray records = in.optJSONArray("records");
            JSONArray results = new JSONArray();
            if (records != null) {
                for (int i = 0; i < records.length(); i++) {
                    JSONObject r = records.optJSONObject(i);
                    boolean ok = r != null && verify(r.optString("canonical", null), r.optString("signature", null));
                    results.put(ok);
                }
            }
            out.put("ok", true);
            out.put("results", results);
        } catch (Exception e) {
            try { out.put("ok", false); out.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
        }
        return out.toString();
    }
}