// Shared by local Gradle builds and generated EAS projects. EAS may supply
// its own release credentials; this guard checks the final selected config.
module.exports = `
// Whisper release signing guard
def whisperStore = System.getenv('WHISPER_RELEASE_STORE_FILE')
if (whisperStore) {
    android.signingConfigs.create('whisperRelease') {
        storeFile file(whisperStore)
        storePassword System.getenv('WHISPER_RELEASE_STORE_PASSWORD')
        keyAlias System.getenv('WHISPER_RELEASE_KEY_ALIAS')
        keyPassword System.getenv('WHISPER_RELEASE_KEY_PASSWORD')
    }
    android.buildTypes.release.signingConfig = android.signingConfigs.whisperRelease
}
gradle.taskGraph.whenReady { graph ->
    if (graph.allTasks.any { it.project == project && it.name.toLowerCase().contains('release') }) {
        def signing = android.buildTypes.release.signingConfig
        if (!signing || !signing.storeFile || !signing.storeFile.exists() ||
            !signing.storePassword || !signing.keyAlias || !signing.keyPassword ||
            signing.keyAlias == 'androiddebugkey' || signing.storeFile.name == 'debug.keystore') {
            throw new GradleException('Release requires production signing credentials. Debug signing is forbidden.')
        }
    }
}
`;
