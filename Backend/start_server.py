#!/usr/bin/env python3
"""
Start the Flask API server for the Practice2Panel AI backend.
"""
import os
import sys
from dotenv import load_dotenv

# Fix Windows console encoding issues
if sys.platform == 'win32':
    # Set UTF-8 encoding for stdout/stderr on Windows
    if sys.stdout.encoding != 'utf-8':
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    if sys.stderr.encoding != 'utf-8':
        import io
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
    # Also set environment variable for subprocesses
    os.environ['PYTHONIOENCODING'] = 'utf-8'

# Load environment variables
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

# Add the current directory to Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import app

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    debug = os.getenv('FLASK_DEBUG', 'True').lower() == 'true'
    
    # Use ASCII-only output for Windows consoles that don't support Unicode emojis
    print("Starting Practice2Panel API server...")
    print(f"Server will run on: http://localhost:{port}")
    print(f"Debug mode: {debug}")
    print(f"Health check: http://localhost:{port}/api/health")
    print(f"Mock interview API: http://localhost:{port}/api/mock-interview/questions")
    print("=" * 60)
    
    app.run(host='0.0.0.0', port=port, debug=debug, use_reloader=False)