<script lang="ts">
  // Minimal loader: a thin rotating arc in the muted foreground colour.
  // Shows only after `delay` ms to avoid flicker on fast loads.
  // Used: centered in editor area, inline on tree nodes, inline on host rows.

  let {
    label,
    delay = 150,
    size = 'md',
  }: {
    label?: string;
    delay?: number;
    size?: 'sm' | 'md' | 'lg';
  } = $props();

  let visible = $state(false);

  const px = $derived(size === 'sm' ? 14 : size === 'lg' ? 24 : 18);
  const fontSize = $derived(size === 'sm' ? '12px' : size === 'lg' ? '16px' : '14px');

  $effect(() => {
    const timer = setTimeout(() => {
      visible = true;
    }, delay);
    return () => clearTimeout(timer);
  });
</script>

{#if visible}
  <div
    class="loader inline-flex items-center gap-2 text-muted-foreground"
    style={`font-size: ${fontSize}`}
    role="status"
    aria-live="polite"
  >
    <svg
      class="loader-arc flex-none"
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" opacity="0.2" />
      <path d="M12 3 a9 9 0 0 1 9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
    {#if label}
      <span class="truncate">{label}</span>
    {:else}
      <span class="sr-only">Loading</span>
    {/if}
  </div>
{/if}

<style>
  .loader-arc {
    animation: loader-spin 0.9s linear infinite;
  }

  @keyframes loader-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Reduced motion: no spin, a slow gentle pulse instead. */
  @media (prefers-reduced-motion: reduce) {
    .loader-arc {
      animation: loader-pulse 2s ease-in-out infinite;
    }
  }

  @keyframes loader-pulse {
    0%,
    100% {
      opacity: 0.45;
    }
    50% {
      opacity: 1;
    }
  }
</style>
