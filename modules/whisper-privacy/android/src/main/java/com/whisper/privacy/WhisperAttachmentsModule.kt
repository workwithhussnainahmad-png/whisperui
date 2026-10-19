package com.whisper.privacy

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.Base64
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer

private const val MAX_BYTES = 3_000_000
// Keep in sync with the iOS AVAssetExportPreset1280x720 standard-quality copy.
private const val SD_SHORT_SIDE = 720
// Higher bitrate reduces grain on the quick preview copy; HD still follows.
private const val SD_VIDEO_BITRATE = 3_500_000

@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
class WhisperAttachmentsModule : Module() {
  private var cleanupFailures = 0
  private fun removeTemporary(file: File) {
    if (file.exists() && !file.delete()) {
      cleanupFailures++
      android.util.Log.w("WhisperCleanup", "native-temp failure count=$cleanupFailures")
    }
  }
  private val context get() = requireNotNull(appContext.reactContext)
  private fun decode(value: String): ByteArray {
    require(value.length <= 4_000_256) { "Attachment too large" }
    return Base64.decode(value, Base64.DEFAULT).also { require(it.size <= MAX_BYTES + 192) }
  }
  private fun temporary(): File = File.createTempFile("whisper-private-", ".tmp", context.cacheDir)

  override fun definition() = ModuleDefinition {
    Name("WhisperAttachments")
    AsyncFunction("privacySelfCheck") {
      check((context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) { "Debug builds only" }
      val info = context.applicationInfo
      var fullBackup = 0
      var extraction = 0
      context.assets.openXmlResourceParser("AndroidManifest.xml").use { parser ->
        while (parser.eventType != org.xmlpull.v1.XmlPullParser.END_DOCUMENT) {
          if (parser.eventType == org.xmlpull.v1.XmlPullParser.START_TAG && parser.name == "application") {
            fullBackup = parser.getAttributeResourceValue("http://schemas.android.com/apk/res/android", "fullBackupContent", 0)
            extraction = parser.getAttributeResourceValue("http://schemas.android.com/apk/res/android", "dataExtractionRules", 0)
          }
          parser.next()
        }
      }
      val vault = File(context.noBackupFilesDir, "vault").canonicalFile
      fun exposed(authority: String, file: File): Boolean = try {
        androidx.core.content.FileProvider.getUriForFile(context, context.packageName + authority, file)
        true
      } catch (_: IllegalArgumentException) { false }
      val authorities = listOf(".SharingFileProvider", ".FileSystemFileProvider", ".ImagePickerFileProvider")
      val privateBlocked = authorities.all { authority ->
        !exposed(authority, File(vault, "probe.box")) &&
        !exposed(authority, File(context.cacheDir, "whisper-chat-media/probe.png")) &&
        !exposed(authority, File(context.filesDir, "probe"))
      }
      mapOf(
        "fileProvidersBlockPrivateStorage" to privateBlocked,
        "qrDirectoryShareable" to exposed(".SharingFileProvider", File(context.cacheDir, "whisper-share/probe.png")),
        "allowBackup" to (info.flags and android.content.pm.ApplicationInfo.FLAG_ALLOW_BACKUP != 0),
        "fullBackupContentLinked" to (fullBackup != 0 && fullBackup == context.resources.getIdentifier("whisper_backup_rules", "xml", context.packageName)),
        "dataExtractionRulesLinked" to (extraction != 0 && extraction == context.resources.getIdentifier("whisper_extraction_rules", "xml", context.packageName)),
        "nativeCleanupFailures" to cleanupFailures,
        "vaultUnderNoBackupFilesDir" to (vault.parentFile == context.noBackupFilesDir.canonicalFile),
        "potentialPlaintextTempFiles" to context.cacheDir.walkTopDown().count { it.isFile && it.extension != "wenc" }
      )
    }
    AsyncFunction("validateImageFile") { uriString: String ->
      val uri = Uri.parse(uriString)
      require(uri.scheme == "file")
      val file = File(requireNotNull(uri.path)).canonicalFile
      require(file.path.startsWith(context.cacheDir.canonicalPath + File.separator))
      require(file.length() in 1..(64L * 1024 * 1024))
      val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(file.path, options)
      // Restrict previews to non-animated JPEG/PNG; other formats can be
      // stored privately without automatic decoding.
      require(options.outMimeType in setOf("image/jpeg", "image/png"))
      require(options.outWidth in 1..8192 && options.outHeight in 1..8192)
      require(options.outWidth.toLong() * options.outHeight <= 16_000_000)
      true
    }
    AsyncFunction("cleanTemporaryFiles") {
      (context.cacheDir.listFiles() ?: error("Cannot inspect temporary storage")).filter { it.name.startsWith("whisper-private-") }.forEach { check(it.delete()) { "Native temporary cleanup failed" } }
    }

    AsyncFunction("renderPdfPage") { base64: String, index: Int ->
      val bytes = decode(base64)
      val file = temporary()
      try {
        file.writeBytes(bytes)
        bytes.fill(0)
        val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        // The renderer owns this descriptor. Unlink immediately; no cached PDF.
        removeTemporary(file)
        descriptor.use { ownedDescriptor -> PdfRenderer(ownedDescriptor).use { renderer ->
          require(renderer.pageCount in 1..100 && index in 0 until renderer.pageCount)
          renderer.openPage(index).use { page ->
            val scale = 1200.0 / maxOf(page.width, page.height)
            val bitmap = Bitmap.createBitmap(maxOf(1, (page.width * scale).toInt()),
              maxOf(1, (page.height * scale).toInt()), Bitmap.Config.ARGB_8888)
            try {
              bitmap.eraseColor(Color.WHITE)
              page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
              val output = ByteArrayOutputStream()
              bitmap.compress(Bitmap.CompressFormat.JPEG, 85, output)
              mapOf("pageCount" to renderer.pageCount, "image" to Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
            } finally { bitmap.recycle() }
          }
        } }
      } finally { bytes.fill(0); removeTemporary(file) }
    }

    // Returns null when the source is already at or below the standard size.
    AsyncFunction("transcodeVideo") { inputUri: String, promise: Promise ->
      val uri = Uri.parse(inputUri)
      require(uri.scheme == "file" || uri.scheme == "content")
      val retriever = MediaMetadataRetriever()
      val shortSide = try {
        retriever.setDataSource(context, uri)
        val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
        val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
        require(width > 0 && height > 0) { "Unsupported video" }
        minOf(width, height)
      } finally { retriever.release() }
      if (shortSide <= SD_SHORT_SIDE) {
        promise.resolve(null)
        return@AsyncFunction
      }
      val output = File.createTempFile("whisper-private-", ".mp4", context.cacheDir)
      // Transformer must be created and driven on a Looper thread.
      Handler(Looper.getMainLooper()).post {
        try {
          val encoder = DefaultEncoderFactory.Builder(context)
            .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(SD_VIDEO_BITRATE).build())
            .setEnableFallback(true)
            .build()
          val transformer = Transformer.Builder(context)
            .setVideoMimeType(MimeTypes.VIDEO_H264)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .setEncoderFactory(encoder)
            .addListener(object : Transformer.Listener {
              override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                promise.resolve(Uri.fromFile(output).toString())
              }
              override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                removeTemporary(output)
                promise.reject("ERR_VIDEO_TRANSCODE", exportException.message ?: "Video conversion failed", exportException)
              }
            })
            .build()
          val item = EditedMediaItem.Builder(MediaItem.fromUri(uri))
            .setEffects(Effects(listOf(), listOf(Presentation.createForShortSide(SD_SHORT_SIDE))))
            .build()
          transformer.start(item, output.absolutePath)
        } catch (error: Exception) {
          removeTemporary(output)
          promise.reject("ERR_VIDEO_TRANSCODE", error.message ?: "Video conversion failed", error)
        }
      }
    }

    AsyncFunction("cleanVideoFile") { inputUri: String ->
      // Only picker-owned local files; never fetch remote URLs.
      val uri = Uri.parse(inputUri)
      require(uri.scheme == "file" || uri.scheme == "content")
      val extractor = MediaExtractor()
      val output = temporary()
      var muxer: MediaMuxer? = null
      var started = false
      var retained = false
      try {
        extractor.setDataSource(context, uri, null)
        val writer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        muxer = writer
        val tracks = mutableMapOf<Int, Int>()
        val kinds = mutableSetOf<String>()
        for (index in 0 until extractor.trackCount) {
          val source = extractor.getTrackFormat(index)
          val mime = source.getString(MediaFormat.KEY_MIME) ?: continue
          if (!mime.startsWith("video/") && !mime.startsWith("audio/")) continue
          require(kinds.add(mime.substringBefore('/'))) { "Multiple tracks of the same type unsupported" }
          require(tracks.size < 2) { "Only one video and one audio track supported" }
          val clean = MediaFormat()
          clean.setString(MediaFormat.KEY_MIME, mime)
          for (key in listOf("width", "height", "sample-rate", "channel-count", "aac-profile", "color-standard", "color-transfer", "color-range")) {
            if (source.containsKey(key)) clean.setInteger(key, source.getInteger(key))
          }
          for (key in listOf("csd-0", "csd-1", "csd-2")) {
            if (source.containsKey(key)) source.getByteBuffer(key)?.let { clean.setByteBuffer(key, it) }
          }
          if (mime.startsWith("video/") && source.containsKey("rotation-degrees")) {
            writer.setOrientationHint(source.getInteger("rotation-degrees"))
          }
          tracks[index] = writer.addTrack(clean)
          extractor.selectTrack(index)
        }
        require(tracks.isNotEmpty()) { "No supported media tracks" }
        writer.start(); started = true
        var buffer = ByteBuffer.allocateDirect(1024 * 1024)
        val info = MediaCodec.BufferInfo()
        while (extractor.sampleTrackIndex >= 0) {
          val needed = extractor.sampleSize
          require(needed in 0L..32_000_000L) { "Unsupported encoded frame size" }
          if (needed > buffer.capacity()) buffer = ByteBuffer.allocateDirect(needed.toInt())
          val track = requireNotNull(tracks[extractor.sampleTrackIndex])
          buffer.clear()
          val size = extractor.readSampleData(buffer, 0)
          if (size < 0) break
          require(extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_ENCRYPTED == 0) { "Encrypted media unsupported" }
          val flags = if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
          info.set(0, size, extractor.sampleTime, flags)
          writer.writeSampleData(track, buffer, info)
          extractor.advance()
        }
        writer.stop(); started = false
        writer.release(); muxer = null
        retained = true
        Uri.fromFile(output).toString()
      } finally {
        if (started) runCatching { muxer?.stop() }
        runCatching { muxer?.release() }
        extractor.release()
        if (!retained) removeTemporary(output)
      }
    }
  }
}
