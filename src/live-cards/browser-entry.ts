import LiveCard from './live-cards-core';

if (typeof globalThis !== 'undefined') {
  (globalThis as { LiveCard?: unknown }).LiveCard = LiveCard;
}
