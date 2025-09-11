import React, { useEffect, useState } from 'react';

export default function TutorialOverlay({ steps, stepIndex, onNext, onPrev, onClose }) {
  const [rect, setRect] = useState(null);
  const step = steps[stepIndex];

  useEffect(() => {
    const el = document.querySelector(step.selector);
    if (el) {
      setRect(el.getBoundingClientRect());
    } else {
      setRect(null);
    }
  }, [step, stepIndex]);

  useEffect(() => {
    function handleKey(e) {
      const key = e.key.toLowerCase();
      if (key === 'escape') {
        onClose();
      } else if (key === 'n') {
        onNext();
      } else if (key === 'p') {
        onPrev();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onNext, onPrev, onClose]);

  if (!rect) return null;

  const isLast = stepIndex === steps.length - 1;

  return (
    <div className="tutorial-overlay">
      <div
        className="tutorial-highlight"
        style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
      />
      <div className="tutorial-tooltip glass-effect" style={{ top: rect.bottom + 10, left: rect.left }}>
        <p>{step.text}</p>
        <div className="tutorial-buttons">
          <button onClick={onClose}>Cancel (Esc)</button>
          <button onClick={onPrev} disabled={stepIndex === 0}>
            Previous (P)
          </button>
          <button onClick={onNext}>{isLast ? 'Finish' : 'Next (N)'}</button>
        </div>
      </div>
    </div>
  );
}
