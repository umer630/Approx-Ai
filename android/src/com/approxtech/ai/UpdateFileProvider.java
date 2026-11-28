package com.approxtech.ai;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.File;
import java.io.FileNotFoundException;

/**
 * Read-only access to exactly one file — the verified update in cache/updates/Approx.apk — for Android's package
 * installer (granted per intent with FLAG_GRANT_READ_URI_PERMISSION; the provider is not exported).
 */
public class UpdateFileProvider extends ContentProvider {
    @Override public boolean onCreate() { return true; }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode) || !"/Approx.apk".equals(uri.getPath())) throw new FileNotFoundException();
        File f = new File(new File(getContext().getCacheDir(), "updates"), "Approx.apk");
        if (!f.isFile()) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public String getType(Uri uri) { return "application/vnd.android.package-archive"; }
    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { return null; }
    @Override public Uri insert(Uri u, ContentValues v) { return null; }
    @Override public int delete(Uri u, String s, String[] a) { return 0; }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
}
