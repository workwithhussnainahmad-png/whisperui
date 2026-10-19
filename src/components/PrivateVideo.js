import React, { useEffect, useMemo, useRef } from 'react';
import { useVideoPlayer, VideoView } from 'expo-video';

// Keep private playback inside the protected chat window, without disk caching.
export default function PrivateVideo({ uri, playing, style, onStopped }) {
  const source = useMemo(() => ({ uri, useCaching: false }), [uri]);
  const callback = useRef(onStopped);
  callback.current = onStopped;
  const player = useVideoPlayer(source, (instance) => {
    instance.loop = false;
    instance.staysActiveInBackground = false;
    instance.showNowPlayingNotification = false;
  });
  useEffect(() => {
    const ended = player.addListener('playToEnd', () => {
      player.currentTime = 0;
      callback.current?.();
    });
    const status = player.addListener('statusChange', ({ error }) => {
      if (error) callback.current?.();
    });
    return () => {
      ended.remove();
      status.remove();
      try { player.pause(); } catch { /* released */ }
    };
  }, [player]);
  useEffect(() => {
    if (playing) player.play();
    else player.pause();
  }, [player, playing]);
  return <VideoView player={player} style={style} contentFit="contain"
    nativeControls={false} fullscreenOptions={{ enable: false }}
    allowsPictureInPicture={false} startsPictureInPictureAutomatically={false}
    surfaceType="textureView" />;
}
