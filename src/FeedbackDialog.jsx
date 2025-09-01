import React, { useState } from 'react';

export default function FeedbackDialog({ onClose }) {
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    const payload = {
      message,
      email: email || null,
      resolution: `${window.innerWidth}x${window.innerHeight}`,
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      href: window.location.href,
      timestamp: new Date().toISOString()
    };
    try {
      await fetch('https://vectrabackyard-3dmb6.ondigitalocean.app/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.error('Failed to send feedback', err, payload);
    }
    onClose();
  }

  return (
    <div className="feedback-overlay">
      <form className="feedback-form glass-effect" onSubmit={handleSubmit}>
        <h2>Feedback</h2>
        <textarea
          placeholder="Your feedback"
          value={message}
          onChange={e => setMessage(e.target.value)}
        />
        <input
          type="email"
          placeholder="Email (optional)"
          value={email}
          onChange={e => setEmail(e.target.value)}
        />
        <div className="feedback-actions">
          <button type="submit" disabled={!message.trim()}>Submit</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

