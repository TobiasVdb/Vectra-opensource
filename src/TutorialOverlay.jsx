import React, { useEffect, useRef, useState } from 'react';

export default function TutorialOverlay({ steps, stepIndex, onNext, onPrev, onClose }) {
  const [rect, setRect] = useState(null);
  const tooltipRef = useRef(null);
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 });
  const step = steps[stepIndex];

  useEffect(() => {
    const el = document.querySelector(step.selector);
    if (el) {
      const elRect = el.getBoundingClientRect();
      setRect(elRect);
      setTooltipPos({ top: elRect.bottom + 10, left: elRect.left });
    } else {
      setRect(null);
    }
  }, [step, stepIndex]);

  useEffect(() => {
    if (!rect || !tooltipRef.current) return;
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    let top = rect.bottom + 10;
    if (top + tooltipRect.height > window.innerHeight) {
      top = rect.top - tooltipRect.height - 10;
      if (top < 10) top = window.innerHeight - tooltipRect.height - 10;
    }
    if (top < 10) top = 10;
    let left = rect.left;
    if (left + tooltipRect.width > window.innerWidth) {
      left = window.innerWidth - tooltipRect.width - 10;
    }
    if (left < 10) left = 10;
    setTooltipPos({ top, left });
  }, [rect, stepIndex]);

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
      <div
        ref={tooltipRef}
        className="tutorial-tooltip glass-effect"
        style={{ top: tooltipPos.top, left: tooltipPos.left }}
      >
        <p>{step.text}</p>
        <div className="tutorial-buttons">
          <button className="secondary-btn" onClick={onClose}>
            Cancel<kbd>Esc</kbd>
          </button>
          <button
            className="secondary-btn"
            onClick={onPrev}
            disabled={stepIndex === 0}
          >
            Previous<kbd>P</kbd>
          </button>
          <button className="primary-btn" onClick={onNext}>
            {isLast ? (
              'Finish'
            ) : (
              <>
                Next<kbd>N</kbd>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
