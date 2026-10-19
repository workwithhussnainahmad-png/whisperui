import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../hooks/useTheme';

/**
 * Thin wrapper over Ionicons that pulls color from the active theme by default
 * and uses a consistent size scale. All icon usage in the app goes through here
 * so the icon language stays uniform.
 *
 * Pass `name` (any Ionicons glyph), `size` (numeric px), and optionally
 * `color` to override the theme text color.
 */
const SIZES = {
  micro: 14,
  sm: 18,
  md: 22,
  lg: 28,
  xl: 34,
};

export default function Icon({ name, size = 'md', color, style }) {
  const { colors } = useTheme();
  const resolvedSize = typeof size === 'number' ? size : SIZES[size] ?? SIZES.md;
  return (
    <Ionicons
      name={name}
      size={resolvedSize}
      color={color ?? colors.text}
      style={style}
    />
  );
}

export { SIZES as iconSizes };
