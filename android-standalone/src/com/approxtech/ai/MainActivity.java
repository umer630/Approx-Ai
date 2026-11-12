package com.approxtech.ai;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Approx AI — STANDALONE offline assistant. No server, no network, no account.
 * Everything runs on the device: text commands handled by OfflineBrain (computed answers), voice input via the
 * device speech recognizer, and spoken replies via the device text-to-speech engine.
 *
 * There is deliberately no server-address field and no INTERNET permission — the app cannot and does not connect
 * anywhere. Open-ended conversation (the Nick 4.8 language model) is not bundled and is honestly reported as
 * unavailable offline rather than faked.
 */
public class MainActivity extends Activity {
    static final int BG = Color.parseColor("#05070D");
    static final int SURFACE = Color.parseColor("#0A1324");
    static final int SURFACE2 = Color.parseColor("#0F1C34");
    static final int LINE = Color.parseColor("#1C2E52");
    static final int TEXT = Color.parseColor("#F4F7FB");
    static final int MUTED = Color.parseColor("#93A3BF");
    static final int GREEN = Color.parseColor("#22D37A");
    static final int TEAL = Color.parseColor("#10D9A0");
    static final int USERBG = Color.parseColor("#123A6B");
    static final int REQ_MIC = 71;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private LinearLayout messages;
    private ScrollView scroll;
    private EditText input;
    private TextView micBtn, sendBtn, speakToggle;
    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private boolean speakReplies = true;
    private boolean listening = false;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setBackgroundDrawableResource(android.R.color.black);
        setContentView(buildUi());
        tts = new TextToSpeech(this, new TextToSpeech.OnInitListener() {
            public void onInit(int status) { ttsReady = status == TextToSpeech.SUCCESS; if (ttsReady) tts.setLanguage(Locale.ENGLISH); }
        });
        addBubble("Approx AI offline assistant is ready — no internet needed. Ask me a calculation, conversion, "
                + "geometry, the date, or a fact. Type \"help\" to see everything I can do on-device.", false);
    }

    @Override
    protected void onDestroy() {
        if (recognizer != null) recognizer.destroy();
        if (tts != null) { tts.stop(); tts.shutdown(); }
        super.onDestroy();
    }

    // ---------------------------------------------------------------- UI
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private TextView tv(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s); t.setTextSize(sp); t.setTextColor(color);
        if (bold) t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        return t;
    }

    private GradientDrawable shape(int fill, int radius, int stroke) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill); g.setCornerRadius(dp(radius));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    private View buildUi() {
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(BG);

        // top bar
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(16), dp(14), dp(16), dp(12));
        top.setBackgroundColor(SURFACE);
        TextView brand = tv("Approx AI", 18, TEXT, true);
        top.addView(brand);
        TextView offline = tv("  ● Offline", 12, GREEN, false);
        top.addView(offline);
        View spacer = new View(this); top.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1));
        speakToggle = tv("🔊 Voice", 13, GREEN, true);
        speakToggle.setPadding(dp(10), dp(6), dp(10), dp(6));
        speakToggle.setBackground(shape(SURFACE2, 999, LINE));
        speakToggle.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
            speakReplies = !speakReplies;
            speakToggle.setText(speakReplies ? "🔊 Voice" : "🔇 Voice");
            speakToggle.setTextColor(speakReplies ? GREEN : MUTED);
            if (!speakReplies && tts != null) tts.stop();
        } });
        top.addView(speakToggle);
        page.addView(top);
        View div = new View(this); div.setBackgroundColor(LINE);
        page.addView(div, new LinearLayout.LayoutParams(-1, dp(1)));

        // message list
        messages = new LinearLayout(this);
        messages.setOrientation(LinearLayout.VERTICAL);
        messages.setPadding(dp(12), dp(12), dp(12), dp(12));
        scroll = new ScrollView(this);
        scroll.addView(messages);
        page.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

        // composer
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(10), dp(8), dp(10), dp(10));
        bar.setBackgroundColor(SURFACE);
        input = new EditText(this);
        input.setHint("Ask or say a command…");
        input.setTextColor(TEXT); input.setHintTextColor(MUTED);
        input.setBackground(shape(SURFACE2, 22, LINE));
        input.setPadding(dp(14), dp(10), dp(14), dp(10));
        input.setMaxLines(4);
        input.setImeOptions(EditorInfo.IME_ACTION_SEND);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        input.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            public boolean onEditorAction(TextView v, int actionId, android.view.KeyEvent e) {
                if (actionId == EditorInfo.IME_ACTION_SEND) { submit(); return true; } return false;
            }
        });
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(0, -2, 1);
        bar.addView(input, ilp);

        micBtn = round("🎤");
        micBtn.setContentDescription("Voice input");
        micBtn.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { onMic(); } });
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(-2, -2); mlp.leftMargin = dp(8);
        bar.addView(micBtn, mlp);

        sendBtn = round("➤");
        sendBtn.setContentDescription("Send");
        sendBtn.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { submit(); } });
        bar.addView(sendBtn, mlp);
        page.addView(bar);
        return page;
    }

    private TextView round(String glyph) {
        TextView t = tv(glyph, 18, Color.parseColor("#04121F"), true);
        t.setGravity(Gravity.CENTER);
        GradientDrawable g = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{TEAL, Color.parseColor("#8CF25B")});
        g.setShape(GradientDrawable.OVAL);
        t.setBackground(g);
        int sz = dp(44);
        t.setLayoutParams(new LinearLayout.LayoutParams(sz, sz));
        return t;
    }

    private void addBubble(String text, boolean user) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(5), 0, dp(5));
        TextView b = tv(text, 15.5f, TEXT, false);
        b.setPadding(dp(13), dp(10), dp(13), dp(10));
        b.setBackground(shape(user ? USERBG : SURFACE2, 16, user ? 0 : LINE));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        lp.leftMargin = user ? dp(48) : 0; lp.rightMargin = user ? 0 : dp(48);
        b.setLayoutParams(lp);
        row.setGravity(user ? Gravity.END : Gravity.START);
        row.addView(b);
        messages.addView(row);
        ui.post(new Runnable() { public void run() { scroll.fullScroll(View.FOCUS_DOWN); } });
    }

    // ---------------------------------------------------------------- handle a command
    private void submit() {
        String q = input.getText().toString().trim();
        if (q.isEmpty()) return;
        input.setText("");
        handle(q);
    }

    private void handle(String q) {
        addBubble(q, true);
        OfflineBrain.Reply r = OfflineBrain.answer(q);
        addBubble(r.text, false);
        if (speakReplies && ttsReady) speak(r.text);
    }

    private void speak(String text) {
        String clean = text.length() > 300 ? text.substring(0, 300) : text;
        if (Build.VERSION.SDK_INT >= 21) tts.speak(clean, TextToSpeech.QUEUE_FLUSH, null, "approx");
        else tts.speak(clean, TextToSpeech.QUEUE_FLUSH, null);
    }

    // ---------------------------------------------------------------- voice input (on-device speech)
    private void onMic() {
        if (listening) { stopListening(); return; }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            toast("No speech recognizer is available on this device. You can still type your command.");
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return;
        }
        startListening();
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req == REQ_MIC) {
            if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) startListening();
            else toast("Microphone permission is needed for voice. You can still type.");
        }
    }

    private void startListening() {
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            recognizer.setRecognitionListener(new RecognitionListener() {
                public void onReadyForSpeech(Bundle p) {}
                public void onBeginningOfSpeech() {}
                public void onRmsChanged(float v) {}
                public void onBufferReceived(byte[] b) {}
                public void onEndOfSpeech() {}
                public void onError(int error) { listening = false; setMicActive(false);
                    if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) toast("Didn't catch that — try again.");
                    else if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) toast("Microphone permission is required.");
                }
                public void onResults(Bundle results) {
                    listening = false; setMicActive(false);
                    ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (list != null && !list.isEmpty()) handle(list.get(0));
                }
                public void onPartialResults(Bundle p) {
                    ArrayList<String> list = p.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (list != null && !list.isEmpty()) input.setText(list.get(0));
                }
                public void onEvent(int t, Bundle p) {}
            });
        }
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault());
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        if (Build.VERSION.SDK_INT >= 23) i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        listening = true; setMicActive(true);
        try { recognizer.startListening(i); } catch (Exception e) { listening = false; setMicActive(false); toast("Could not start voice input."); }
    }

    private void stopListening() {
        listening = false; setMicActive(false);
        if (recognizer != null) recognizer.stopListening();
    }

    private void setMicActive(boolean on) {
        ui.post(new Runnable() { public void run() {
            micBtn.setText(on ? "⏺" : "🎤");
            hideKeyboardIfNeeded(on);
        } });
    }

    private void hideKeyboardIfNeeded(boolean on) {
        if (on) {
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(input.getWindowToken(), 0);
        }
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_LONG).show(); }
}
