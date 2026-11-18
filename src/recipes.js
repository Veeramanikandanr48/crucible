import './site.css';
import './brand.js';
import './recipes.css';

const COPIED_LABEL_MILLISECONDS = 2000;

function mountCopyButton(button) {
  const source = document.getElementById(button.dataset.copyCode);
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(source.textContent);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, COPIED_LABEL_MILLISECONDS);
    } catch {
      getSelection().selectAllChildren(source);
    }
  });
}

document.querySelectorAll('[data-copy-code]').forEach(mountCopyButton);

// A clip that moves on its own stops for people who asked for less motion; its first frame stays as the picture.
if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.querySelectorAll('.recipe-clip').forEach(video => {
    video.removeAttribute('autoplay');
    video.pause();
    video.controls = true;
  });
}
