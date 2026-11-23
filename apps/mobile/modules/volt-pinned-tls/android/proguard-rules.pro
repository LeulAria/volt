# setWebViewPins finds the patched react-native-webview's pin registry by name.
-keep class com.reactnativecommunity.webview.RNCWebViewClient {
	public static void setPinnedCertificates(java.util.Map);
}
