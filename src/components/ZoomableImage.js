import React, { useRef } from 'react';
import { View, Animated, PanResponder, StyleSheet } from 'react-native';

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 260;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const distance = ([a, b]) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);

// Pinch to zoom, drag to pan while zoomed, double-tap to toggle zoom.
export default function ZoomableImage({ uri, style, onError }) {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const g = useRef({
    width: 0, height: 0, scale: 1, x: 0, y: 0,
    pinch: null, pan: null, lastTap: 0, moved: false,
  }).current;

  const bounded = (s, x, y) => {
    const maxX = (g.width * (s - 1)) / 2;
    const maxY = (g.height * (s - 1)) / 2;
    return [clamp(x, -maxX, maxX), clamp(y, -maxY, maxY)];
  };
  const apply = (s, x, y) => {
    const [bx, by] = bounded(s, x, y);
    g.scale = s; g.x = bx; g.y = by;
    scale.setValue(s); translateX.setValue(bx); translateY.setValue(by);
  };
  const animateTo = (s, x, y) => {
    const [bx, by] = bounded(s, x, y);
    g.scale = s; g.x = bx; g.y = by;
    Animated.parallel([
      Animated.spring(scale, { toValue: s, useNativeDriver: true, friction: 8 }),
      Animated.spring(translateX, { toValue: bx, useNativeDriver: true, friction: 8 }),
      Animated.spring(translateY, { toValue: by, useNativeDriver: true, friction: 8 }),
    ]).start();
  };

  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => g.scale <= 1,
    onPanResponderGrant: () => { g.moved = false; g.pinch = null; g.pan = null; },
    onPanResponderMove: (event, gesture) => {
      const touches = event.nativeEvent.touches;
      if (touches.length >= 2) {
        g.moved = true;
        g.pan = null;
        const d = distance(touches);
        if (!g.pinch) { g.pinch = { d, scale: g.scale, x: g.x, y: g.y }; return; }
        const next = clamp(g.pinch.scale * (d / g.pinch.d), 1, MAX_SCALE);
        const ratio = next / g.pinch.scale;
        apply(next, g.pinch.x * ratio, g.pinch.y * ratio);
        return;
      }
      g.pinch = null;
      if (Math.abs(gesture.dx) > 4 || Math.abs(gesture.dy) > 4) g.moved = true;
      if (g.scale <= 1) return;
      if (!g.pan) { g.pan = { dx: gesture.dx, dy: gesture.dy, x: g.x, y: g.y }; return; }
      apply(g.scale, g.pan.x + gesture.dx - g.pan.dx, g.pan.y + gesture.dy - g.pan.dy);
    },
    onPanResponderRelease: (event) => {
      g.pinch = null; g.pan = null;
      if (g.scale < 1.05) { animateTo(1, 0, 0); return; }
      if (g.moved) return;
      const now = Date.now();
      if (now - g.lastTap < DOUBLE_TAP_MS) {
        g.lastTap = 0;
        if (g.scale > 1) { animateTo(1, 0, 0); return; }
        const { locationX, locationY } = event.nativeEvent;
        const s = DOUBLE_TAP_SCALE;
        animateTo(s, (g.width / 2 - locationX) * (s - 1), (g.height / 2 - locationY) * (s - 1));
        return;
      }
      g.lastTap = now;
    },
    onPanResponderTerminate: () => { g.pinch = null; g.pan = null; },
  })).current;

  return (
    <View style={[style, s.clip]} {...responder.panHandlers}
      onLayout={({ nativeEvent: { layout } }) => { g.width = layout.width; g.height = layout.height; }}>
      <Animated.Image source={{ uri, cache: 'reload' }} resizeMode="contain" onError={onError}
        style={[StyleSheet.absoluteFill, { transform: [{ translateX }, { translateY }, { scale }] }]} />
    </View>
  );
}

const s = StyleSheet.create({
  clip: { overflow: 'hidden' },
});
