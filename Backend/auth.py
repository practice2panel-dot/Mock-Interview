"""
Authentication module with signup, login, verification, password reset, and Google OAuth.
"""
from flask import Blueprint, request, jsonify, session
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta
import random
import re
import os
import time
from collections import defaultdict, deque
from functools import wraps
from db_handler import get_pg_connection
from email_service import (
    send_verification_code,
    send_password_reset_code,
    send_welcome_email,
    send_password_change_notification
)
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
import secrets

auth_bp = Blueprint('auth', __name__)

# Simple in-memory rate limiting (per IP/email) to reduce brute force risk
RATE_LIMITS = {
    "signup": (5, 60),
    "login": (10, 60),
    "verify_email": (5, 60),
    "resend_verification": (3, 60),
    "forgot_password": (5, 60),
    "verify_reset_code": (5, 60),
    "reset_password": (5, 60),
}
_rate_buckets = defaultdict(deque)

def _get_client_ip():
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"

def _rate_limit_key(action, email=None):
    ip = _get_client_ip()
    email_part = (email or "").lower().strip()
    return f"{action}:{ip}:{email_part}"

def _check_rate_limit(action, email=None):
    limit, window = RATE_LIMITS.get(action, (10, 60))
    key = _rate_limit_key(action, email)
    now = time.time()
    bucket = _rate_buckets[key]
    while bucket and now - bucket[0] > window:
        bucket.popleft()
    if len(bucket) >= limit:
        retry_after = int(window - (now - bucket[0]))
        return False, max(retry_after, 1)
    bucket.append(now)
    return True, None

# Blueprint error handler to ensure CORS headers
@auth_bp.errorhandler(500)
def handle_auth_500_error(e):
    """Handle 500 errors in auth blueprint with CORS headers"""
    from flask import request, jsonify
    
    origin = request.headers.get('Origin', 'http://localhost:3000')
    allowed_origins = [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:3001',
        'http://127.0.0.1:3001',
        'http://localhost:3002',
        'http://127.0.0.1:3002'
    ]
    
    try:
        error_msg = str(e)
        error_msg = error_msg.encode('ascii', 'replace').decode('ascii')
    except:
        error_msg = "Internal server error"
    
    response = jsonify({
        'success': False,
        'message': f'Auth error: {error_msg}'
    })
    
    if origin.rstrip('/') in allowed_origins:
        response.headers['Access-Control-Allow-Origin'] = origin
    response.headers['Access-Control-Allow-Credentials'] = 'true'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, Accept, Origin'
    
    return response, 500

# Email validation regex
EMAIL_REGEX = re.compile(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')

def login_required(f):
    """Decorator for routes that require login (returns HTML response)"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'success': False, 'message': 'Please login to access this resource'}), 401
        return f(*args, **kwargs)
    return decorated_function

def api_login_required(f):
    """Decorator for API routes that require login (returns JSON response)"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'success': False, 'message': 'Authentication required'}), 401
        return f(*args, **kwargs)
    return decorated_function

def generate_verification_code():
    """Generate a 6-digit verification code"""
    return str(random.randint(100000, 999999))

def validate_email(email):
    """Validate email format"""
    if not email or not EMAIL_REGEX.match(email):
        return False
    return True

def validate_password(password):
    """Validate password (minimum 6 characters)"""
    if not password or len(password) < 6:
        return False
    return True

# ==================== SIGNUP ====================
@auth_bp.route('/api/auth/signup', methods=['POST'])
def signup():
    """User signup endpoint"""
    try:
        data = request.get_json()
        email = data.get('email', '').strip().lower()
        password = data.get('password', '')
        full_name = data.get('full_name', '').strip()
        
        allowed, retry_after = _check_rate_limit("signup", email)
        if not allowed:
            return jsonify({
                'success': False,
                'message': f'Too many signup attempts. Try again in {retry_after}s.'
            }), 429
        
        # Validation
        if not email:
            return jsonify({'success': False, 'message': 'Email is required'}), 400
        if not validate_email(email):
            return jsonify({'success': False, 'message': 'Invalid email format'}), 400
        if not password:
            return jsonify({'success': False, 'message': 'Password is required'}), 400
        if not validate_password(password):
            return jsonify({'success': False, 'message': 'Password must be at least 6 characters'}), 400
        if not full_name:
            return jsonify({'success': False, 'message': 'Full name is required'}), 400
        
        conn = get_pg_connection()
        try:
            with conn.cursor() as cursor:
                # Check if email already exists
                cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
                if cursor.fetchone():
                    return jsonify({'success': False, 'message': 'Email already registered'}), 400
                
                # Generate password hash with salt (SHA-256 via werkzeug)
                password_hash = generate_password_hash(password, method='pbkdf2:sha256')
                
                # Generate verification code
                verification_code = generate_verification_code()
                verification_expires = datetime.now() + timedelta(minutes=15)
                
                # Insert user
                cursor.execute("""
                    INSERT INTO users (email, password_hash, full_name, 
                                     verification_code, verification_expires)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING id
                """, (email, password_hash, full_name, 
                      verification_code, verification_expires))
                
                user_id = cursor.fetchone()[0]
                conn.commit()
                
                # Send verification email
                email_sent, email_error = send_verification_code(email, verification_code, full_name)
                if not email_sent:
                    # User created but email failed - log but don't fail signup
                    print(f"Warning: Failed to send verification email: {email_error}")
                
                return jsonify({
                    'success': True,
                    'message': 'Account created successfully. Please check your email for verification code.',
                    'user_id': user_id
                }), 201
        
        except Exception as e:
            conn.rollback()
            return jsonify({'success': False, 'message': f'Database error: {str(e)}'}), 500
        finally:
            conn.close()
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'Server error: {str(e)}'}), 500

# ==================== VERIFY EMAIL ====================
@auth_bp.route('/api/auth/verify-email', methods=['POST'])
def verify_email():
    """Verify email with verification code"""
    try:
        data = request.get_json()
        email = data.get('email', '').strip().lower()
        code = data.get('code', '').strip()
        
        allowed, retry_after = _check_rate_limit("verify_email", email)
        if not allowed:
            return jsonify({
                'success': False,
                'message': f'Too many attempts. Try again in {retry_after}s.'
            }), 429
        
        if not email or not code:
            return jsonify({'success': False, 'message': 'Email and verification code are required'}), 400
        
        conn = get_pg_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    SELECT id, full_name, verification_code, verification_expires, is_verified
                    FROM users WHERE email = %s
                """, (email,))
                
                user = cursor.fetchone()
                if not user:
                    return jsonify({'success': False, 'message': 'User not found'}), 404
                
                user_id, full_name, stored_code, expires, is_verified = user
                
                if is_verified:
                    return jsonify({'success': False, 'message': 'Email already verified'}), 400
                
                if not stored_code or stored_code != code:
                    return jsonify({'success': False, 'message': 'Invalid verification code'}), 400
                
                if expires < datetime.now():
                    return jsonify({'success': False, 'message': 'Verification code expired'}), 400
                
                # Verify user
                cursor.execute("""
                    UPDATE users 
                    SET is_verified = TRUE, verification_code = NULL, verification_expires = NULL
                    WHERE id = %s
                """, (user_id,))
                
                conn.commit()
                
                # Send welcome email
                send_welcome_email(email, full_name)
                
                return jsonify({
                    'success': True,
                    'message': 'Email verified successfully'
                }), 200
        
        except Exception as e:
            conn.rollback()
            return jsonify({'success': False, 'message': f'Database error: {str(e)}'}), 500
        finally:
            conn.close()
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'Server error: {str(e)}'}), 500

# ==================== RESEND VERIFICATION CODE ====================
@auth_bp.route('/api/auth/resend-verification', methods=['POST'])
def resend_verification():
    """Resend verification code with 60-second cooldown"""
    try:
        data = request.get_json()
        email = data.get('email', '').strip().lower()
        
        allowed, retry_after = _check_rate_limit("resend_verification", email)
        if not allowed:
            return jsonify({
                'success': False,
                'message': f'Too many requests. Try again in {retry_after}s.'
            }), 429
        
        if not email:
            return jsonify({'success': False, 'message': 'Email is required'}), 400
        
        conn = get_pg_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    SELECT id, full_name, verification_code, verification_expires, is_verified
                    FROM users WHERE email = %s
                """, (email,))
                
                user = cursor.fetchone()
                if not user:
                    return jsonify({'success': False, 'message': 'User not found'}), 404
                
                user_id, full_name, stored_code, expires, is_verified = user
                
                if is_verified:
                    return jsonify({'success': False, 'message': 'Email already verified'}), 400
                
                # Check cooldown (60 seconds)
                if stored_code and expires:
                    time_since_creation = (expires - datetime.now()).total_seconds()
                    if time_since_creation > (15 * 60 - 60):  # Less than 60 seconds passed
                        return jsonify({
                            'success': False,
                            'message': 'Please wait 60 seconds before requesting a new code'
                        }), 429
                
                # Generate new code
                verification_code = generate_verification_code()
                verification_expires = datetime.now() + timedelta(minutes=15)
                
                cursor.execute("""
                    UPDATE users 
                    SET verification_code = %s, verification_expires = %s
                    WHERE id = %s
                """, (verification_code, verification_expires, user_id))
                
                conn.commit()
                
                # Send verification email
                email_sent, email_error = send_verification_code(email, verification_code, full_name)
                if not email_sent:
                    return jsonify({'success': False, 'message': f'Failed to send email: {email_error}'}), 500
                
                return jsonify({
                    'success': True,
                    'message': 'Verification code sent successfully'
                }), 200
        
        except Exception as e:
            conn.rollback()
            return jsonify({'success': False, 'message': f'Database error: {str(e)}'}), 500
        finally:
            conn.close()
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'Server error: {str(e)}'}), 500

# ==================== LOGIN ====================
@auth_bp.route('/api/auth/login', methods=['POST'])
def login():
    """User login endpoint"""
    try:
        data = request.get_json()
        email = data.get('email', '').strip().lower()
        password = data.get('password', '')
        remember_me = data.get('remember_me', False)
        
        allowed, retry_after = _check_rate_limit("login", email)
        if not allowed:
            return jsonify({
                'success': False,
                'message': f'Too many login attempts. Try again in {retry_after}s.'
            }), 429
        
        if not email or not password:
            return jsonify({'success': False, 'message': 'Email and password are required'}), 400
        
        conn = get_pg_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    SELECT id, email, password_hash, full_name, is_verified, is_active
                    FROM users WHERE email = %s
                """, (email,))
                
                user = cursor.fetchone()
                if not user:
                    return jsonify({'success': False, 'message': 'Invalid email or password'}), 401
                
                user_id, db_email, password_hash, full_name, is_verified, is_active = user
                
                # Check account status
                if not is_active:
                    return jsonify({'success': False, 'message': 'Account is deactivated'}), 403
                
                # Check email verification
                if not is_verified:
                    return jsonify({
                        'success': False,
                        'message': 'Please verify your email before logging in'
                    }), 403
                
                # Verify password
                if not password_hash or not check_password_hash(password_hash, password):
                    return jsonify({'success': False, 'message': 'Invalid email or password'}), 401
                
                # Update last login
                cursor.execute("""
                    UPDATE users SET last_login = %s WHERE id = %s
                """, (datetime.now(), user_id))
                conn.commit()
                
                # Create session
                session['user_id'] = user_id
                session['email'] = db_email
                session['full_name'] = full_name
                
                # Set session expiry (30 days for remember me, else browser session)
                if remember_me:
                    session.permanent = True
                    # Flask session default expiry is 31 days
                else:
                    session.permanent = False
                
                return jsonify({
                    'success': True,
                    'message': 'Login successful',
                    'user': {
                        'id': user_id,
                        'email': db_email,
                        'full_name': full_name
                    }
                }), 200
        
        except Exception as e:
            conn.rollback()
            return jsonify({'success': False, 'message': f'Database error: {str(e)}'}), 500
        finally:
            conn.close()
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'Server error: {str(e)}'}), 500

# ==================== LOGOUT ====================
@auth_bp.route('/api/auth/logout', methods=['POST'])
def logout():
    """User logout endpoint"""
    try:
        session.clear()
        return jsonify({
            'success': True,
            'message': 'Logged out successfully'
        }), 200
    except Exception as e:
        return jsonify({'success': False, 'message': f'Server error: {str(e)}'}), 500

# ==================== FORGOT PASSWORD ====================
@auth_bp.route('/api/auth/forgot-password', methods=['POST'])
def forgot_password():
    """Request password reset code"""
    try:
        data = request.get_json()
        email = data.get('email', '').strip().lower()
        
        allowed, retry_after = _check_rate_limit("forgot_password", email)
        if not allowed:
            return jsonify({
                'success': False,
                'message': f'Too many requests. Try again in {retry_after}s.'
            }), 429
        
        if not email:
            return jsonify({'success': False, 'message': 'Email is required'}), 400
        
        conn = get_pg_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    SELECT id, full_name, is_verified FROM users WHERE email = %s
                """, (email,))
                
                user = cursor.fetchone()
                if not user:
                    # Don't reveal if email exists (security)
                    return jsonify({
                        'success': True,
                        'message': 'If the email exists, a reset code has been sent'
                    }), 200
                
                user_id, full_name, is_verified = user
                
                if not is_verified:
                    return jsonify({
                        'success': False,
                        'message': 'Please verify your email first'
                    }), 403
                
                # Generate reset code
                reset_token = generate_verification_code()
                reset_expires = datetime.now() + timedelta(minutes=15)
                
                cursor.execute("""
                    UPDATE users 
                    SET reset_token = %s, reset_expires = %s
                    WHERE id = %s
                """, (reset_token, reset_expires, user_id))
                
                conn.commit()
                
                # Send reset code email
                email_sent, email_error = send_password_reset_code(email, reset_token, full_name)
                if not email_sent:
                    return jsonify({'success': False, 'message': f'Failed to send email: {email_error}'}), 500
                
                return jsonify({
                    'success': True,
                    'message': 'If the email exists, a reset code has been sent'
                }), 200
        
        except Exception as e:
            conn.rollback()
            return jsonify({'success': False, 'message': f'Database error: {str(e)}'}), 500
        finally:
            conn.close()
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'Server error: {str(e)}'}), 500

# ==================== VERIFY RESET CODE ====================
@auth_bp.route('/api/auth/verify-reset-code', methods=['POST'])
def verify_reset_code():
    """Verify password reset code"""
    try:
        data = request.get_json()
        email = data.get('email', '').strip().lower()
        code = data.get('code', '').strip()
        
        allowed, retry_after = _check_rate_limit("verify_reset_code", email)
        if not allowed:
            return jsonify({
                'success': False,
                'message': f'Too many attempts. Try again in {retry_after}s.'
            }), 429
        
        if not email or not code:
            return jsonify({'success': False, 'message': 'Email and reset code are required'}), 400
        
        conn = get_pg_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    SELECT id, reset_token, reset_expires FROM users WHERE email = %s
                """, (email,))
                
                user = cursor.fetchone()
                if not user:
                    return jsonify({'success': False, 'message': 'Invalid reset code'}), 400
                
                user_id, reset_token, reset_expires = user
                
                if not reset_token or reset_token != code:
                    return jsonify({'success': False, 'message': 'Invalid reset code'}), 400
                
                if not reset_expires or reset_expires < datetime.now():
                    return jsonify({'success': False, 'message': 'Reset code expired'}), 400
                
                # Code is valid - don't clear it yet, wait for password reset
                return jsonify({
                    'success': True,
                    'message': 'Reset code verified'
                }), 200
        
        except Exception as e:
            return jsonify({'success': False, 'message': f'Database error: {str(e)}'}), 500
        finally:
            conn.close()
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'Server error: {str(e)}'}), 500

# ==================== RESET PASSWORD ====================
@auth_bp.route('/api/auth/reset-password', methods=['POST'])
def reset_password():
    """Reset password with reset code"""
    try:
        data = request.get_json()
        email = data.get('email', '').strip().lower()
        code = data.get('code', '').strip()
        new_password = data.get('new_password', '')
        
        allowed, retry_after = _check_rate_limit("reset_password", email)
        if not allowed:
            return jsonify({
                'success': False,
                'message': f'Too many attempts. Try again in {retry_after}s.'
            }), 429
        
        if not email or not code or not new_password:
            return jsonify({'success': False, 'message': 'Email, reset code, and new password are required'}), 400
        
        if not validate_password(new_password):
            return jsonify({'success': False, 'message': 'Password must be at least 6 characters'}), 400
        
        conn = get_pg_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    SELECT id, reset_token, reset_expires, full_name FROM users WHERE email = %s
                """, (email,))
                
                user = cursor.fetchone()
                if not user:
                    return jsonify({'success': False, 'message': 'Invalid reset code'}), 400
                
                user_id, reset_token, reset_expires, full_name = user
                
                if not reset_token or reset_token != code:
                    return jsonify({'success': False, 'message': 'Invalid reset code'}), 400
                
                if not reset_expires or reset_expires < datetime.now():
                    return jsonify({'success': False, 'message': 'Reset code expired'}), 400
                
                # Update password
                password_hash = generate_password_hash(new_password, method='pbkdf2:sha256')
                cursor.execute("""
                    UPDATE users 
                    SET password_hash = %s, reset_token = NULL, reset_expires = NULL
                    WHERE id = %s
                """, (password_hash, user_id))
                
                conn.commit()
                
                # Send notification email
                send_password_change_notification(email, full_name)
                
                return jsonify({
                    'success': True,
                    'message': 'Password reset successfully'
                }), 200
        
        except Exception as e:
            conn.rollback()
            return jsonify({'success': False, 'message': f'Database error: {str(e)}'}), 500
        finally:
            conn.close()
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'Server error: {str(e)}'}), 500

# ==================== CHANGE PASSWORD ====================
@auth_bp.route('/api/auth/change-password', methods=['POST'])
@api_login_required
def change_password():
    """Change password for logged-in users"""
    try:
        data = request.get_json()
        current_password = data.get('current_password', '')
        new_password = data.get('new_password', '')
        
        if not current_password or not new_password:
            return jsonify({'success': False, 'message': 'Current password and new password are required'}), 400
        
        if not validate_password(new_password):
            return jsonify({'success': False, 'message': 'Password must be at least 6 characters'}), 400
        
        user_id = session.get('user_id')
        
        conn = get_pg_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    SELECT password_hash, email, full_name FROM users WHERE id = %s
                """, (user_id,))
                
                user = cursor.fetchone()
                if not user:
                    return jsonify({'success': False, 'message': 'User not found'}), 404
                
                password_hash, email, full_name = user
                
                # Verify current password
                if not password_hash or not check_password_hash(password_hash, current_password):
                    return jsonify({'success': False, 'message': 'Current password is incorrect'}), 401
                
                # Update password
                new_password_hash = generate_password_hash(new_password, method='pbkdf2:sha256')
                cursor.execute("""
                    UPDATE users SET password_hash = %s WHERE id = %s
                """, (new_password_hash, user_id))
                
                conn.commit()
                
                # Send notification email
                send_password_change_notification(email, full_name)
                
                return jsonify({
                    'success': True,
                    'message': 'Password changed successfully'
                }), 200
        
        except Exception as e:
            conn.rollback()
            return jsonify({'success': False, 'message': f'Database error: {str(e)}'}), 500
        finally:
            conn.close()
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'Server error: {str(e)}'}), 500

# ==================== GET USER PROFILE ====================
@auth_bp.route('/api/auth/profile', methods=['GET'])
@api_login_required
def get_profile():
    """Get user profile"""
    try:
        user_id = session.get('user_id')
        
        conn = get_pg_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    SELECT id, email, full_name, is_verified, 
                           created_at, last_login, is_active
                    FROM users WHERE id = %s
                """, (user_id,))
                
                user = cursor.fetchone()
                if not user:
                    return jsonify({'success': False, 'message': 'User not found'}), 404
                
                return jsonify({
                    'success': True,
                    'user': {
                        'id': user[0],
                        'email': user[1],
                        'full_name': user[2],
                        'is_verified': user[3],
                        'created_at': user[4].isoformat() if user[4] else None,
                        'last_login': user[5].isoformat() if user[5] else None,
                        'is_active': user[6]
                    }
                }), 200
        
        except Exception as e:
            return jsonify({'success': False, 'message': f'Database error: {str(e)}'}), 500
        finally:
            conn.close()
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'Server error: {str(e)}'}), 500

# ==================== UPDATE USER PROFILE ====================
@auth_bp.route('/api/auth/profile', methods=['PUT'])
@api_login_required
def update_profile():
    """Update user profile"""
    try:
        data = request.get_json()
        full_name = data.get('full_name', '').strip()
        
        if not full_name:
            return jsonify({'success': False, 'message': 'Full name is required'}), 400
        
        user_id = session.get('user_id')
        
        conn = get_pg_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    UPDATE users 
                    SET full_name = %s
                    WHERE id = %s
                    RETURNING id, email, full_name
                """, (full_name, user_id))
                
                user = cursor.fetchone()
                if not user:
                    return jsonify({'success': False, 'message': 'User not found'}), 404
                
                conn.commit()
                
                # Update session
                session['full_name'] = user[2]
                
                return jsonify({
                    'success': True,
                    'message': 'Profile updated successfully',
                    'user': {
                        'id': user[0],
                        'email': user[1],
                        'full_name': user[2]
                    }
                }), 200
        
        except Exception as e:
            conn.rollback()
            return jsonify({'success': False, 'message': f'Database error: {str(e)}'}), 500
        finally:
            conn.close()
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'Server error: {str(e)}'}), 500

# ==================== GOOGLE OAUTH ====================
def safe_jsonify(data, status_code=200, add_cors=True):
    """Create JSON response with ASCII-safe encoding for Windows console and CORS headers"""
    try:
        # Recursively make all strings ASCII-safe
        def make_ascii_safe(obj):
            if isinstance(obj, dict):
                return {k: make_ascii_safe(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [make_ascii_safe(item) for item in obj]
            elif isinstance(obj, str):
                try:
                    return obj.encode('ascii', 'replace').decode('ascii')
                except:
                    return str(obj).encode('ascii', 'replace').decode('ascii')
            else:
                return obj
        
        safe_data = make_ascii_safe(data)
        response = jsonify(safe_data)
        
        # Add CORS headers if requested (only if not already present to avoid duplicates)
        if add_cors and 'Access-Control-Allow-Origin' not in response.headers:
            try:
                origin = request.headers.get('Origin', 'http://localhost:3000')
            except:
                origin = 'http://localhost:3000'

            # Include production frontend URL from environment plus localhost variants
            frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:3000').rstrip('/')
            allowed_origins = {
                frontend_url,
                'http://localhost:3000',
                'http://127.0.0.1:3000',
                'http://localhost:3001',
                'http://127.0.0.1:3001',
                'http://localhost:3002',
                'http://127.0.0.1:3002',
            }
            if origin.rstrip('/') in allowed_origins:
                response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Credentials'] = 'true'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, Accept, Origin'
        
        return response, status_code
    except Exception as e:
        # Fallback to basic jsonify if something goes wrong
        try:
            error_msg = str(e).encode('ascii', 'replace').decode('ascii')
        except:
            error_msg = "Error creating response"
        
        response = jsonify({'success': False, 'message': f'Error creating response: {error_msg}'})
        if add_cors and 'Access-Control-Allow-Origin' not in response.headers:
            try:
                origin = request.headers.get('Origin', 'http://localhost:3000')
            except:
                origin = 'http://localhost:3000'
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Credentials'] = 'true'
        return response, 500

@auth_bp.route('/api/auth/google/authorize', methods=['GET', 'OPTIONS'])
def google_authorize():
    """Get Google OAuth authorization URL"""
    # Wrap entire function to catch Unicode encoding errors
    try:
        return _google_authorize_impl()
    except UnicodeEncodeError as ue:
        # Handle Unicode encoding errors specifically
        try:
            error_msg = str(ue).encode('ascii', 'replace').decode('ascii')
        except:
            error_msg = "Unicode encoding error occurred"
        
        response = jsonify({
            'success': False,
            'message': f'Encoding error: {error_msg}'
        })
        origin = request.headers.get('Origin', 'http://localhost:3000')
        allowed_origins = [
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://localhost:3001',
            'http://127.0.0.1:3001',
            'http://localhost:3002',
            'http://127.0.0.1:3002'
        ]
        if origin.rstrip('/') in allowed_origins:
            response.headers.add('Access-Control-Allow-Origin', origin)
        response.headers.add('Access-Control-Allow-Credentials', 'true')
        return response, 500

def _google_authorize_impl():
    """Implementation of Google OAuth authorization"""
    # Handle CORS preflight
    if request.method == 'OPTIONS':
        from flask import make_response
        response = make_response()
        origin = request.headers.get('Origin', 'http://localhost:3000')
        allowed_origins = [
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://localhost:3001',
            'http://127.0.0.1:3001',
            'http://localhost:3002',
            'http://127.0.0.1:3002'
        ]
        if origin.rstrip('/') in allowed_origins:
            response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, Accept, Origin'
        response.headers['Access-Control-Allow-Credentials'] = 'true'
        return response, 200
    
    try:
        from google_auth_oauthlib.flow import Flow
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests
        
        # Google OAuth configuration
        GOOGLE_CLIENT_ID = os.getenv('GOOGLE_CLIENT_ID')
        GOOGLE_CLIENT_SECRET = os.getenv('GOOGLE_CLIENT_SECRET')
        FRONTEND_URL = os.getenv('FRONTEND_URL', 'http://localhost:3000')
        allowed_frontend_origins = {
            FRONTEND_URL.rstrip('/'),
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://localhost:3001',
            'http://127.0.0.1:3001',
            'http://localhost:3002',
            'http://127.0.0.1:3002'
        }

        request_origin = request.headers.get('Origin')
        if request_origin and request_origin.rstrip('/') in allowed_frontend_origins:
            frontend_origin = request_origin.rstrip('/')
        else:
            frontend_origin = FRONTEND_URL.rstrip('/')

        # Ensure no trailing slash (Google is strict about this)
        redirect_uri = f"{frontend_origin}/auth/google/callback"
        redirect_uri = redirect_uri.rstrip('/')  # Remove any trailing slash
        
        configured_redirect_uris = {f"{origin}/auth/google/callback" for origin in allowed_frontend_origins}
        configured_redirect_uris.add(redirect_uri)
        
        # Safe print helper for Windows console
        def safe_print(msg):
            try:
                safe_msg = str(msg).encode('ascii', 'replace').decode('ascii')
                print(safe_msg)
            except:
                pass
        
        safe_print(f"[Google OAuth Authorize] Using redirect URI: {redirect_uri}")
        safe_print(f"[Google OAuth Authorize] All configured redirect URIs: {list(configured_redirect_uris)}")
        
        if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
            return safe_jsonify({
                'success': False,
                'message': 'Google OAuth not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env'
            }, 500)
        
        # Allow HTTP in local development (required by oauthlib)
        if redirect_uri.startswith('http://'):
            os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'

        # Create OAuth flow
        try:
            # Convert set to list and ensure all are strings
            redirect_uris_list = [str(uri) for uri in list(configured_redirect_uris)]
            
            flow = Flow.from_client_config(
                {
                    "web": {
                        "client_id": GOOGLE_CLIENT_ID,
                        "client_secret": GOOGLE_CLIENT_SECRET,
                        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                        "token_uri": "https://oauth2.googleapis.com/token",
                        "redirect_uris": redirect_uris_list
                    }
                },
                scopes=['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile']
            )
        except Exception as flow_error:
            error_msg = str(flow_error).encode('ascii', 'replace').decode('ascii')
            safe_print(f"[Google OAuth] Error creating OAuth flow: {error_msg}")
            return safe_jsonify({
                'success': False,
                'message': f'Error initializing Google OAuth: {error_msg}'
            }, 500, add_cors=True)
        
        # Explicitly set redirect_uri to avoid "Missing required parameter: redirect_uri"
        flow.redirect_uri = redirect_uri
        
        # Log redirect URI for debugging - THIS MUST MATCH EXACTLY IN GOOGLE CONSOLE
        safe_print(f"[Google OAuth Authorize] Using redirect URI: '{redirect_uri}'")
        safe_print(f"[Google OAuth Authorize] Redirect URI length: {len(redirect_uri)}")
        safe_print(f"[Google OAuth Authorize] Frontend URL: {frontend_origin}")
        safe_print(f"[Google OAuth Authorize] IMPORTANT: This redirect URI MUST be in Google Console: {redirect_uri}")

        # Generate authorization URL with error handling
        try:
            # First call authorization_url so Flow can generate a PKCE code_verifier
            # which Google now expects for some clients.
            serializer = URLSafeTimedSerializer(
                os.getenv("SECRET_KEY", "dev-secret-key"),
                salt="google-oauth-state",
            )
            # Placeholder state; we'll override with signed token below
            nonce = secrets.token_urlsafe(16)
            unsigned_state = serializer.dumps({"nonce": nonce})

            authorization_url, state = flow.authorization_url(
                state=unsigned_state,
                access_type='offline',
                include_granted_scopes='true',
                prompt='consent'
            )

            # Now build the final signed state token including redirect_uri and PKCE code_verifier
            code_verifier = getattr(flow, "code_verifier", None)
            state_payload = {
                "nonce": nonce,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            }
            state_token = serializer.dumps(state_payload)
            # Replace state in authorization URL with our signed token
            import urllib.parse
            parsed = urllib.parse.urlparse(authorization_url)
            params = urllib.parse.parse_qs(parsed.query)
            params["state"] = [state_token]
            new_query = urllib.parse.urlencode(params, doseq=True)
            authorization_url = urllib.parse.urlunparse(
                (
                    parsed.scheme,
                    parsed.netloc,
                    parsed.path,
                    parsed.params,
                    new_query,
                    parsed.fragment,
                )
            )
            state = state_token
        except Exception as auth_url_error:
            error_msg = str(auth_url_error).encode('ascii', 'replace').decode('ascii')
            safe_print(f"[Google OAuth] Error generating authorization URL: {error_msg}")
            return safe_jsonify({
                'success': False,
                'message': f'Error generating Google OAuth URL: {error_msg}',
                'hint': 'Check Google Cloud Console credentials and redirect URIs'
            }, 500, add_cors=True)
        
        # CRITICAL: Extract the EXACT redirect_uri from the authorization URL
        # This is what Google actually sees and must match Google Console EXACTLY
        import urllib.parse
        parsed = urllib.parse.urlparse(authorization_url)
        params = urllib.parse.parse_qs(parsed.query)
        if 'redirect_uri' in params:
            url_redirect_uri = urllib.parse.unquote(params['redirect_uri'][0])
            safe_print(f"[Google OAuth Authorize] Redirect URI in authorization URL: '{url_redirect_uri}'")
            safe_print(f"[Google OAuth Authorize] Our redirect URI: '{redirect_uri}'")
            if url_redirect_uri != redirect_uri:
                safe_print(f"[Google OAuth Authorize] WARNING: Redirect URI mismatch detected!")
                safe_print(f"  Our value: '{redirect_uri}'")
                safe_print(f"  In URL:   '{url_redirect_uri}'")
                # Use the one from URL - this is what Google sees
                redirect_uri = url_redirect_uri
                safe_print(f"[Google OAuth Authorize] Using redirect URI from authorization URL: '{redirect_uri}'")
            else:
                safe_print(f"[Google OAuth Authorize] Redirect URI matches!")
        else:
            safe_print(f"[Google OAuth Authorize] WARNING: redirect_uri not found in authorization URL!")
        
        # Debug logging
        safe_print(f"[Google OAuth] Using signed state token (prefix): {state[:20]}...")
        safe_print(f"[Google OAuth] Request origin: {request.headers.get('Origin')}")
        
        # Add CORS headers to response - use safe_jsonify
        try:
            # Make sure authorization_url is ASCII-safe
            safe_auth_url = str(authorization_url).encode('ascii', 'replace').decode('ascii')
            
            response_data = {
            'success': True,
                'authorization_url': safe_auth_url
            }
            response, status = safe_jsonify(response_data, 200, add_cors=True)
            return response, status
        except Exception as response_error:
            error_msg = str(response_error).encode('ascii', 'replace').decode('ascii')
            safe_print(f"[Google OAuth] Error creating response: {error_msg}")
            return safe_jsonify({
                'success': False,
                'message': f'Error creating response: {error_msg}'
            }, 500, add_cors=True)
        
    except ImportError as e:
        return safe_jsonify({
            'success': False,
            'message': 'Google OAuth libraries not installed. Please run: pip install google-auth google-auth-oauthlib google-auth-httplib2'
        }, 500, add_cors=True)
    except Exception as e:
        import traceback
        
        # Safely encode error message for Windows console
        try:
            error_msg = str(e)
            error_msg = error_msg.encode('ascii', 'replace').decode('ascii')
        except Exception:
            error_msg = "An error occurred during Google OAuth authorization"
        
        # Safe print function for Windows console
        def safe_print_error(msg):
            try:
                safe_msg = str(msg).encode('ascii', 'replace').decode('ascii')
                print(safe_msg)
            except:
                print("Error occurred (encoding issue)")
        
        # Print full traceback for debugging
        try:
            tb_str = traceback.format_exc()
            tb_str = tb_str.encode('ascii', 'replace').decode('ascii')
            safe_print_error(f"[ERROR] Google OAuth authorize error: {error_msg}")
            safe_print_error(f"[ERROR] Traceback:")
            safe_print_error(tb_str)
        except Exception as print_error:
            safe_print_error(f"[ERROR] Google OAuth authorize error: {error_msg}")
            try:
                print_error_msg = str(print_error).encode('ascii', 'replace').decode('ascii')
                safe_print_error(f"[ERROR] Also failed to print traceback: {print_error_msg}")
            except:
                safe_print_error("[ERROR] Also failed to print traceback")
        
        # Return error response with CORS headers
        try:
            return safe_jsonify({
                'success': False, 
                'message': f'Google OAuth error: {error_msg}',
                'error_type': type(e).__name__
            }, 500, add_cors=True)
        except Exception as json_error:
            # Last resort - basic response
            try:
                response = jsonify({'success': False, 'message': 'Google OAuth error occurred'})
                origin = request.headers.get('Origin', 'http://localhost:3000')
                response.headers['Access-Control-Allow-Origin'] = origin
                response.headers['Access-Control-Allow-Credentials'] = 'true'
                return response, 500
            except:
                # Absolute last resort
                return jsonify({'success': False, 'message': 'Server error'}), 500

@auth_bp.route('/api/auth/google/callback', methods=['POST'])
def google_callback():
    """Handle Google OAuth callback"""
    # Safe print helper for Windows console
    def safe_print_callback(msg):
        try:
            safe_msg = str(msg).encode('ascii', 'replace').decode('ascii')
            print(safe_msg)
        except:
            pass
    
    try:
        from google_auth_oauthlib.flow import Flow
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests
        
        data = request.get_json()
        authorization_code = data.get('code')
        state = data.get('state')
        
        if not authorization_code:
            return jsonify({'success': False, 'message': 'Authorization code missing'}), 400
        
        # Verify state without relying on session cookies (stateless signed token)
        safe_print_callback(f"[Google OAuth Callback] Received state: {state[:20] if state else 'None'}...")
        serializer = URLSafeTimedSerializer(
            os.getenv("SECRET_KEY", "dev-secret-key"),
            salt="google-oauth-state",
        )
        try:
            state_payload = serializer.loads(state, max_age=15 * 60)  # 15 minutes
        except SignatureExpired:
            return jsonify({
                'success': False,
                'message': 'Invalid state parameter: State expired. Please try "Continue with Google" again.',
            }), 400
        except BadSignature:
            return jsonify({
                'success': False,
                'message': 'Invalid state parameter: State invalid. Please try "Continue with Google" again.',
            }), 400
        except Exception:
            return jsonify({
                'success': False,
                'message': 'Invalid state parameter. Please try "Continue with Google" again.',
            }), 400
        
        # Google OAuth configuration
        GOOGLE_CLIENT_ID = os.getenv('GOOGLE_CLIENT_ID')
        GOOGLE_CLIENT_SECRET = os.getenv('GOOGLE_CLIENT_SECRET')
        FRONTEND_URL = os.getenv('FRONTEND_URL', 'http://localhost:3000')
        allowed_frontend_origins = {
            FRONTEND_URL.rstrip('/'),
            'http://localhost:3000',
            'http://127.0.0.1:3000'
        }

        request_origin = request.headers.get('Origin')

        # CRITICAL: Use redirect URI embedded in the signed state token (no session required)
        redirect_uri = str(state_payload.get("redirect_uri", "")).rstrip("/")
        if redirect_uri:
            safe_print_callback(f"[Google OAuth Callback] Using redirect URI from state token: {redirect_uri}")
        elif request_origin and request_origin.rstrip('/') in allowed_frontend_origins:
            redirect_uri = f"{request_origin.rstrip('/')}/auth/google/callback".rstrip("/")
            safe_print_callback(f"[Google OAuth Callback] WARNING: No redirect in state, using from request origin: {redirect_uri}")
        else:
            redirect_uri = f"{FRONTEND_URL.rstrip('/')}/auth/google/callback".rstrip("/")
            safe_print_callback(f"[Google OAuth Callback] WARNING: No redirect in state, using default: {redirect_uri}")

        # Ensure no trailing slash (Google is strict about this)
        # Double check - remove any trailing slash
        redirect_uri = redirect_uri.rstrip('/')
        
        safe_print_callback(f"[Google OAuth Callback] Final redirect URI (no trailing slash): '{redirect_uri}'")
        safe_print_callback(f"[Google OAuth Callback] Redirect URI length: {len(redirect_uri)}")
        safe_print_callback(f"[Google OAuth Callback] Redirect URI ends with: '{redirect_uri[-20:]}'")
        
        configured_redirect_uris = {f"{origin}/auth/google/callback" for origin in allowed_frontend_origins}
        configured_redirect_uris.add(redirect_uri)
        
        safe_print_callback(f"[Google OAuth Callback] Final redirect URI: {redirect_uri}")
        safe_print_callback(f"[Google OAuth Callback] All configured redirect URIs: {list(configured_redirect_uris)}")
        
        if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
            return jsonify({
                'success': False,
                'message': 'Google OAuth not configured'
            }), 500
        
        # Allow HTTP in local development (required by oauthlib)
        if redirect_uri.startswith('http://'):
            os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'

        # Create OAuth flow
        flow = Flow.from_client_config(
            {
                "web": {
                    "client_id": GOOGLE_CLIENT_ID,
                    "client_secret": GOOGLE_CLIENT_SECRET,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": list(configured_redirect_uris)
                }
            },
            scopes=['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
            state=state
        )
        
        # Set redirect_uri BEFORE fetching token (must match exactly what was used in authorization request)
        flow.redirect_uri = redirect_uri
        
        # Exchange authorization code for tokens
        # Construct the authorization response URL - redirect_uri must match EXACTLY what's in Google Console
        authorization_response = f"{redirect_uri}?code={authorization_code}&state={state}"
        
        # Safe print helper for Windows console
        def safe_print_callback(msg):
            try:
                safe_msg = str(msg).encode('ascii', 'replace').decode('ascii')
                print(safe_msg)
            except:
                pass
        
        try:
            safe_print_callback(f"[Google OAuth] Attempting token exchange")
            safe_print_callback(f"[Google OAuth] Redirect URI: {redirect_uri}")
            safe_print_callback(f"[Google OAuth] Authorization code: {authorization_code[:20] if authorization_code else 'None'}...")
            safe_print_callback(f"[Google OAuth] State: {state[:20] if state else 'None'}...")
            safe_print_callback(f"[Google OAuth] Authorization response URL: {authorization_response}")
            safe_print_callback(f"[Google OAuth] Flow redirect_uri: {flow.redirect_uri}")
            # Restore PKCE code_verifier from signed state, if present
            code_verifier = state_payload.get("code_verifier")
            if code_verifier:
                safe_print_callback(f"[Google OAuth] Using PKCE code_verifier from state")
                flow.code_verifier = code_verifier
            
            # Fetch token using authorization_response URL and PKCE verifier if available
            # The redirect_uri in the URL must match EXACTLY what's configured in Google Console
            if code_verifier:
                flow.fetch_token(
                    authorization_response=authorization_response,
                    code_verifier=code_verifier,
                )
            else:
                flow.fetch_token(authorization_response=authorization_response)
            
            # Clear state from session after successful token exchange
            # This prevents code reuse if the request is made multiple times
            session.pop('oauth_state', None)
            session.pop('oauth_redirect_uri', None)
        except Exception as token_error:
            # More detailed error message for debugging
            # Make error text safe for Windows consoles that can't print emojis
            try:
                error_msg = str(token_error)
                error_msg = error_msg.encode("ascii", "replace").decode("ascii")
            except Exception:
                error_msg = "Error during Google OAuth token exchange"

            print(f"[Google OAuth] Token exchange error: {error_msg}")
            print(f"[Google OAuth] Redirect URI used: {redirect_uri}")
            print(f"[Google OAuth] Client ID: {GOOGLE_CLIENT_ID[:20] if GOOGLE_CLIENT_ID else 'None'}...")
            print(f"[Google OAuth] Authorization code: {authorization_code[:10] if authorization_code else 'None'}...")
            
            # Check if it's an invalid_grant error (code expired or reused)
            if 'invalid_grant' in error_msg.lower():
                return jsonify({
                    'success': False,
                    'message': 'Authorization code expired or already used. Please try "Continue with Google" again.',
                    'error': 'The authorization code can only be used once and expires quickly. Close all tabs and try again.'
                }), 400
            
            # Check for redirect_uri_mismatch - this is the most common error
            if 'redirect_uri_mismatch' in error_msg.lower() or 'redirect_uri' in error_msg.lower():
                # Try to extract the exact error details from Google
                import json
                error_details = error_msg
                try:
                    # Sometimes the error is in JSON format
                    if '{' in error_msg:
                        error_json = json.loads(error_msg.split('{')[1].split('}')[0] if '{' in error_msg else '{}')
                        if 'error_description' in error_json:
                            error_details = error_json['error_description']
                except:
                    pass
                
                # Make sure error_details is ASCII-safe
                try:
                    error_details = str(error_details).encode('ascii', 'replace').decode('ascii')
                except:
                    error_details = "Redirect URI mismatch error"
                
                # Make redirect_uri safe for printing
                safe_redirect_uri = str(redirect_uri).encode('ascii', 'replace').decode('ascii')
                
                return jsonify({
                    'success': False,
                    'message': 'Redirect URI mismatch. The redirect URI must match EXACTLY in Google Cloud Console.',
                    'error': error_details,
                    'redirect_uri_used': safe_redirect_uri,
                    'redirect_uri_length': len(redirect_uri),
                    'help': f'''CRITICAL: In Google Cloud Console -> Credentials -> OAuth 2.0 Client -> Authorized redirect URIs

Add this EXACT redirect URI (copy-paste this exactly):
{safe_redirect_uri}

IMPORTANT CHECKLIST:
- NO trailing slash (ends with /callback NOT /callback/)
- Use http:// NOT https:// (for localhost)
- Port number must match your frontend port
- NO extra spaces before or after
- Must be EXACTLY: {safe_redirect_uri}

After adding, wait 1-2 minutes, then restart backend and try again.''',
                    'troubleshooting': 'See Backend/OAUTH_TROUBLESHOOTING.md for detailed steps'
                }), 400
            
            # Make error message and redirect_uri ASCII-safe
            safe_error_msg = str(error_msg).encode('ascii', 'replace').decode('ascii')
            safe_redirect_uri = str(redirect_uri).encode('ascii', 'replace').decode('ascii')
            
            return jsonify({
                'success': False,
                'message': f'Failed to exchange authorization code. Make sure redirect URI in Google Console matches exactly: {safe_redirect_uri}',
                'error': safe_error_msg,
                'redirect_uri_used': safe_redirect_uri,
                'help': 'Check Google Cloud Console -> Credentials -> OAuth 2.0 Client -> Authorized redirect URIs'
            }), 400
        
        # Get user info
        credentials = flow.credentials
        id_info = id_token.verify_oauth2_token(
            credentials.id_token,
            google_requests.Request(),
            GOOGLE_CLIENT_ID,
            clock_skew_in_seconds=10,
        )
        
        google_id = id_info.get('sub')
        email = id_info.get('email', '').lower()
        full_name = id_info.get('name', '')
        picture = id_info.get('picture', '')
        
        if not email:
            return jsonify({'success': False, 'message': 'Email not provided by Google'}), 400
        
        conn = get_pg_connection()
        try:
            with conn.cursor() as cursor:
                # Check if user exists by Google ID
                cursor.execute("""
                    SELECT id, email, full_name, is_verified, is_active
                    FROM users WHERE google_id = %s
                """, (google_id,))
                
                user = cursor.fetchone()
                
                if user:
                    # Existing Google user
                    user_id, db_email, db_full_name, is_verified, is_active = user
                    
                    if not is_active:
                        return jsonify({'success': False, 'message': 'Account is deactivated'}), 403
                    
                    # Update last login
                    cursor.execute("""
                        UPDATE users SET last_login = %s WHERE id = %s
                    """, (datetime.now(), user_id))
                    conn.commit()
                    
                    # Create session
                    session['user_id'] = user_id
                    session['email'] = db_email
                    session['full_name'] = db_full_name
                    
                    return jsonify({
                        'success': True,
                        'message': 'Login successful',
                        'user': {
                            'id': user_id,
                            'email': db_email,
                            'full_name': db_full_name
                        }
                    }), 200
                else:
                    # Check if email exists (regular user)
                    cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
                    existing_user = cursor.fetchone()
                    
                    if existing_user:
                        # Email exists but no Google ID - link accounts
                        user_id = existing_user[0]
                        cursor.execute("""
                            UPDATE users 
                            SET google_id = %s, is_verified = TRUE, last_login = %s
                            WHERE id = %s
                        """, (google_id, datetime.now(), user_id))
                        conn.commit()
                        
                        cursor.execute("SELECT email, full_name FROM users WHERE id = %s", (user_id,))
                        user_data = cursor.fetchone()
                        
                        session['user_id'] = user_id
                        session['email'] = user_data[0]
                        session['full_name'] = user_data[1]
                        
                        return jsonify({
                            'success': True,
                            'message': 'Google account linked successfully',
                            'user': {
                                'id': user_id,
                                'email': user_data[0],
                                'full_name': user_data[1]
                            }
                        }), 200
                    else:
                        # New user - create account
                        cursor.execute("""
                            INSERT INTO users (email, full_name, google_id, is_verified, last_login)
                            VALUES (%s, %s, %s, TRUE, %s)
                            RETURNING id
                        """, (email, full_name, google_id, datetime.now()))
                        
                        user_id = cursor.fetchone()[0]
                        conn.commit()
                        
                        # Send welcome email
                        send_welcome_email(email, full_name)
                        
                        # Create session
                        session['user_id'] = user_id
                        session['email'] = email
                        session['full_name'] = full_name
                        
                        return jsonify({
                            'success': True,
                            'message': 'Account created successfully with Google',
                            'user': {
                                'id': user_id,
                                'email': email,
                                'full_name': full_name
                            }
                        }), 201
        
        except Exception as e:
            conn.rollback()
            return jsonify({'success': False, 'message': f'Database error: {str(e)}'}), 500
        finally:
            conn.close()
    
    except ImportError as e:
        return jsonify({
            'success': False,
            'message': 'Google OAuth libraries not installed. Please run: pip install google-auth google-auth-oauthlib google-auth-httplib2'
        }), 500
    except Exception as e:
        import traceback
        # Make callback error logging safe for Windows console encodings
        try:
            error_msg = str(e)
            error_msg = error_msg.encode("ascii", "replace").decode("ascii")
        except Exception:
            error_msg = "Error during Google OAuth callback handling"

        try:
            tb_str = traceback.format_exc()
            tb_str = tb_str.encode("ascii", "replace").decode("ascii")
            print(f"Google OAuth callback error: {error_msg}")
            print(tb_str)
        except Exception:
            print(f"Google OAuth callback error: {error_msg}")

        return jsonify({'success': False, 'message': f'Google OAuth error: {error_msg}'}), 500

# ==================== CHECK AUTH STATUS ====================
@auth_bp.route('/api/auth/check', methods=['GET'])
def check_auth():
    """Check if user is authenticated"""
    try:
        if 'user_id' in session:
            return jsonify({
                'success': True,
                'authenticated': True,
                'user': {
                    'id': session.get('user_id'),
                    'email': session.get('email'),
                    'full_name': session.get('full_name')
                }
            }), 200
        else:
            return jsonify({
                'success': True,
                'authenticated': False
            }), 200
    except Exception as e:
        return jsonify({'success': False, 'message': f'Server error: {str(e)}'}), 500

