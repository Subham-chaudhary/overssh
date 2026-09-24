<script lang="ts">
  interface Props {
    size?: number;
    class?: string;
  }

  const { size = 64, class: className }: Props = $props();

  // SVG viewBox is 1024x1024
  const viewSize = 1024;
</script>

<svg
  width={size}
  height={size}
  viewBox={`0 0 ${viewSize} ${viewSize}`}
  xmlns="http://www.w3.org/2000/svg"
  role="img"
  aria-label="OverSSH"
  class={className}
>
  <!-- Rounded square background using sidebar color -->
  <rect x="64" y="64" width="896" height="896" rx="200" fill="var(--sidebar)" />
  <!-- Rounded square border using primary color -->
  <rect x="64" y="64" width="896" height="896" rx="200" fill="none" stroke="var(--primary)" stroke-width="40" />
  <!-- Up chevron using primary color -->
  <path
    d="M242 590 L372 410 L502 590"
    fill="none"
    stroke="var(--primary)"
    stroke-width="72"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
  <!-- Underscore using success color -->
  <path
    d="M562 632 H782"
    stroke="var(--success)"
    stroke-width="72"
    stroke-linecap="round"
  />
</svg>

<style>
  svg {
    display: inline-block;
  }
</style>
