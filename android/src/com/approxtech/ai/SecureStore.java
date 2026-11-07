package com.approxtech.ai;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Stores the session token encrypted with a non-exportable AES-256-GCM key held in the
 * Android Keystore. Backups are disabled in the manifest. Non-secret prefs (server URL,
 * last model/mode) are stored in plain app-private SharedPreferences.
 */
public final class SecureStore {
    private static final String ALIAS = "approx_session_key";
    private final SharedPreferences prefs;

    public SecureStore(Context ctx) {
        prefs = ctx.getSharedPreferences("approx", Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    public void setToken(String token) {
        if (token == null) { prefs.edit().remove("tok").remove("iv").apply(); return; }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] ct = c.doFinal(token.getBytes(StandardCharsets.UTF_8));
            prefs.edit().putString("tok", Base64.encodeToString(ct, Base64.NO_WRAP))
                    .putString("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP)).apply();
        } catch (Exception e) {
            prefs.edit().remove("tok").remove("iv").apply(); // never fall back to plaintext
        }
    }

    public String getToken() {
        String t = prefs.getString("tok", null);
        String iv = prefs.getString("iv", null);
        if (t == null || iv == null) return null;
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            return new String(c.doFinal(Base64.decode(t, Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    public String get(String k, String def) { return prefs.getString(k, def); }
    public void put(String k, String v) { prefs.edit().putString(k, v).apply(); }
}
