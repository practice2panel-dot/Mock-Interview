import json
import logging
import os
from random import shuffle

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_session import Session
from psycopg2 import sql

from auth import auth_bp
from cors_config import get_allowed_origins, get_vercel_origin_pattern, is_origin_allowed
from db_handler import create_users_table, get_pg_connection
from voice_processor import get_openai_client, process_voice_response

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

app = Flask(__name__)


def _vapi_private_key():
    raw = (os.getenv("VAPI_PRIVATE_KEY", "") or os.getenv("VAPI_API_KEY", "")).strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        raw = raw[1:-1].strip()
    return raw


def _execute_db_query(query, params=None, fetch_one=False, fetch_all=False):
    conn = get_pg_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(query, params)
            if fetch_one:
                return cursor.fetchone(), None
            if fetch_all:
                return cursor.fetchall(), None
            conn.commit()
            return True, None
    except Exception as exc:
        return None, str(exc)
    finally:
        conn.close()


# Keep server-side role->skills mapping in sync with frontend jobRolesConfig.js
PLATFORM_SKILLS = {
    "AI Engineer": ["Machine Learning", "Python", "TensorFlow", "PyTorch", "Deep Learning"],
    "Data Scientist": ["Python", "Machine Learning", "SQL", "Data Analysis", "Statistics"],
    "Python Developer": ["Python", "AWS", "Kubernetes", "Docker", "Lambda"],
    "Machine Learning Engineer": ["Python", "Machine Learning", "Deep Learning", "TensorFlow", "PyTorch"],
    "MLOps Engineer": ["AWS", "Docker", "Kubernetes", "Machine Learning", "Python"],
    "Data Engineer": ["Python", "SQL", "AWS", "Lambda", "Docker"],
    "Deep Learning Engineer": ["Python", "Deep Learning", "TensorFlow", "PyTorch", "AWS"],
    "Cloud AI Engineer": ["AWS", "Lambda", "Machine Learning", "Docker", "Python"],
    "Backend Engineer (AI/ML Focused)": ["Python", "SQL", "AWS", "Docker", "Machine Learning"],
}


def resolve_mock_interview_skills(job_role, client_skills=None):
    if job_role in PLATFORM_SKILLS:
        return list(PLATFORM_SKILLS[job_role])
    if isinstance(client_skills, list) and client_skills:
        cleaned = [str(s).strip() for s in client_skills if str(s).strip()]
        return cleaned if cleaned else None
    return None


def get_question_table_name(interview_type, skill=""):
    normalized_type = interview_type.lower() if interview_type else "default"
    if normalized_type == "behavioral":
        return "behavioralquestions"
    return f"{interview_type}_{skill.lower().replace(' ', '')}"


# Session configuration (required by auth + protected API cookies)
secret_key = os.getenv("SECRET_KEY")
is_production = any(
    (
        os.getenv("FLASK_ENV", "").lower() == "production",
        os.getenv("ENV", "").lower() == "production",
        os.getenv("APP_ENV", "").lower() == "production",
        os.getenv("RENDER", "").lower() == "true",
        bool(os.getenv("RENDER_SERVICE_ID")),
    )
)

if not secret_key:
    if is_production:
        raise RuntimeError("SECRET_KEY is required in production")
    secret_key = "dev-secret-key"
    logger.warning("SECRET_KEY not set; using dev-only key")

app.config["SECRET_KEY"] = secret_key
app.config["SESSION_TYPE"] = "filesystem"
app.config["SESSION_PERMANENT"] = False
app.config["SESSION_USE_SIGNER"] = True
app.config["SESSION_KEY_PREFIX"] = "practice2panel:"
app.config["PERMANENT_SESSION_LIFETIME"] = 2592000
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "None" if is_production else "Lax"
app.config["SESSION_COOKIE_SECURE"] = True if is_production else False
app.config["SESSION_COOKIE_DOMAIN"] = None
app.config["SESSION_COOKIE_PATH"] = "/"

Session(app)

allowed_origins = get_allowed_origins()
vercel_origin_pattern = get_vercel_origin_pattern()


def _flask_cors_origins():
    out = list(allowed_origins)
    if vercel_origin_pattern:
        out.append(vercel_origin_pattern)
    return out


CORS(
    app,
    supports_credentials=True,
    origins=_flask_cors_origins(),
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "Accept", "Origin", "X-Requested-With"],
    expose_headers=["Set-Cookie"],
)


@app.before_request
def handle_preflight():
    if request.method != "OPTIONS":
        return None
    origin = request.headers.get("Origin")
    if not origin or not is_origin_allowed(origin, allowed_origins, vercel_origin_pattern):
        return jsonify({"success": False, "message": "CORS origin not allowed"}), 403
    response = jsonify({"success": True})
    response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Accept, Origin, X-Requested-With"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Credentials"] = "true"
    response.headers["Access-Control-Max-Age"] = "3600"
    return response, 200


@app.after_request
def add_cors_headers(response):
    if "Access-Control-Allow-Origin" not in response.headers:
        origin = request.headers.get("Origin")
        if origin and is_origin_allowed(origin, allowed_origins, vercel_origin_pattern):
            response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Accept, Origin, X-Requested-With"
    return response


app.register_blueprint(auth_bp)

try:
    create_users_table()
    logger.info("Users table initialized")
except Exception as exc:
    logger.warning("Users table initialization warning: %s", exc)


def get_questions_from_table(table_name):
    table_exists_query = """
        SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE LOWER(table_name) = LOWER(%s)
        );
    """
    exists, error = _execute_db_query(table_exists_query, (table_name,), fetch_one=True)
    if error:
        return None, error
    if not exists or not exists[0]:
        return None, f"Table '{table_name}' does not exist"

    table_name_query = """
        SELECT table_name
        FROM information_schema.tables
        WHERE LOWER(table_name) = LOWER(%s)
        LIMIT 1;
    """
    table_result, error = _execute_db_query(table_name_query, (table_name,), fetch_one=True)
    if error or not table_result:
        return None, f"Could not find table '{table_name}'"

    actual_table_name = table_result[0]
    query = sql.SQL("SELECT question FROM {} ORDER BY id").format(sql.Identifier(actual_table_name))
    rows, error = _execute_db_query(query, fetch_all=True)
    if error:
        return None, error
    return [row[0] for row in rows] if rows else [], None


@app.route("/api/health", methods=["GET"])
def health_check():
    return jsonify({"success": True, "message": "API is running", "status": "healthy"})


@app.route("/api/process-voice", methods=["POST"])
def process_voice():
    try:
        if "audio" not in request.files:
            return jsonify({"success": False, "message": "No audio file provided"}), 400

        audio_file = request.files["audio"]
        if audio_file.filename == "":
            return jsonify({"success": False, "message": "No audio file selected"}), 400

        question = request.form.get("question", "Mock interview question")
        return jsonify(process_voice_response(audio_file, question))
    except Exception as exc:
        return jsonify({"success": False, "message": f"Server error during voice processing: {exc}"}), 500


@app.route("/api/mock-interview/questions", methods=["POST"])
def get_mock_interview_questions():
    try:
        data = request.get_json() or {}
        job_role = data.get("job_role", "")
        interview_type = data.get("interview_type", "technical")
        client_skills = data.get("skills")

        if not job_role:
            return jsonify({"success": False, "message": "Job role is required"}), 400

        skills = resolve_mock_interview_skills(job_role, client_skills)
        if not skills:
            return jsonify({"success": False, "message": "Valid skills are required for this job role"}), 400

        all_questions = []
        questions_per_skill = 3
        normalized_type = interview_type.lower() if interview_type else "default"

        if normalized_type == "behavioral":
            table_name = get_question_table_name(interview_type)
            questions, error = get_questions_from_table(table_name)
            if not error and questions:
                shuffle(questions)
                for question in questions[: min(15, len(questions))]:
                    all_questions.append(
                        {"question": question, "skill": "Behavioral", "interview_type": interview_type}
                    )
        else:
            for skill in skills:
                table_name = get_question_table_name(interview_type, skill)
                questions, error = get_questions_from_table(table_name)
                if not error and questions:
                    shuffle(questions)
                    for question in questions[: min(questions_per_skill, len(questions))]:
                        all_questions.append({"question": question, "skill": skill, "interview_type": interview_type})

        shuffle(all_questions)

        if not all_questions:
            return jsonify({"success": False, "message": f"No questions found for {interview_type} interview type"}), 404

        return jsonify({"success": True, "questions": all_questions, "total_questions": len(all_questions)})
    except Exception as exc:
        logger.exception("Error fetching mock interview questions")
        return jsonify({"success": False, "message": f"Server error: {exc}"}), 500


@app.route("/api/mock-interview/get-assistant-config", methods=["POST"])
def get_assistant_config():
    try:
        data = request.get_json() or {}
        candidate_name = data.get("candidate_name", "Candidate")
        questions = data.get("questions", [])
        system_message = data.get("system_message", "")
        assistant_message = data.get("assistant_message", "")

        vapi_api_key = _vapi_private_key()
        if not vapi_api_key:
            return jsonify({"success": False, "message": "VAPI API key not configured"}), 500

        questions_text = "\n".join(
            [f"{idx + 1}. [{q.get('skill', '')}] {q.get('question', '')}" for idx, q in enumerate(questions)]
        )
        assistant_config_for_api = {
            "model": {
                "provider": "openai",
                "model": "gpt-4o-mini",
                "messages": [
                    {"role": "system", "content": system_message},
                    {"role": "assistant", "content": f"{assistant_message}\n\nQuestions to ask:\n{questions_text}"},
                ],
                "temperature": 0.7,
                "maxTokens": 500,
            },
            "voice": {"provider": "vapi", "voiceId": "Elliot"},
            "firstMessage": (
                f"Hello {candidate_name}, thank you for taking the time to interview with us today. "
                "I'm excited to learn more about your background and experience. Let's begin!"
            ),
        }

        assistant_config_for_web = {
            "model": {
                "provider": "openai",
                "model": "gpt-4o-mini",
                "messages": assistant_config_for_api["model"]["messages"],
                "temperature": 0.7,
            },
            "voice": {"provider": "vapi", "voiceId": "Elliot"},
            "firstMessage": assistant_config_for_api["firstMessage"],
        }

        response = requests.post(
            "https://api.vapi.ai/assistant",
            json=assistant_config_for_api,
            headers={"Authorization": f"Bearer {vapi_api_key}", "Content-Type": "application/json"},
            timeout=30,
        )

        if response.status_code in (200, 201):
            assistant_id = response.json().get("id")
            return jsonify({"success": True, "assistantId": assistant_id, "assistant": assistant_config_for_web})

        error_text = response.text
        try:
            error_text = response.json().get("message", error_text)
        except ValueError:
            pass

        return jsonify(
            {
                "success": True,
                "assistant": assistant_config_for_web,
                "warning": f"Assistant creation failed ({response.status_code}): {error_text}. Using inline config.",
            }
        )
    except Exception as exc:
        logger.exception("Error getting assistant config")
        return jsonify({"success": False, "message": f"Server error: {exc}"}), 500


@app.route("/api/mock-interview/feedback", methods=["POST"])
def generate_interview_feedback():
    try:
        data = request.get_json() or {}
        conversation_history = data.get("conversation_history", [])
        job_role = data.get("job_role", "")
        interview_type = data.get("interview_type", "technical")
        candidate_name = data.get("candidate_name", "Candidate")

        meaningful = [
            msg
            for msg in conversation_history
            if isinstance(msg, dict)
            and msg.get("content")
            and len(str(msg.get("content", "")).strip()) > 5
        ]
        user_messages = [
            msg for msg in meaningful if msg.get("role") == "user" and len(str(msg.get("content", "")).strip()) > 10
        ]
        if len(meaningful) < 2 or not user_messages:
            return jsonify(
                {
                    "success": False,
                    "message": "Insufficient conversation data. Please complete the interview before generating feedback.",
                }
            ), 400

        conversation_text = "\n".join(
            [f"{'Interviewer' if m.get('role') == 'assistant' else 'Candidate'}: {m.get('content')}" for m in meaningful]
        )
        prompt = f"""
Evaluate this {interview_type} mock interview for role {job_role}.
Candidate: {candidate_name}

Conversation:
{conversation_text}

Return strict JSON:
{{
  "overall_score": <0-100>,
  "key_strengths": ["..."],
  "weaknesses": ["..."],
  "how_to_improve": ["..."],
  "recommended_topics": ["..."],
  "summary": "..."
}}
"""
        client = get_openai_client()
        model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        completion = client.chat.completions.create(
            model=model,
            temperature=0.2,
            messages=[
                {"role": "system", "content": "You are an expert interview evaluator. Respond only with JSON."},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
        )
        feedback_data = json.loads(completion.choices[0].message.content)
        feedback_data.setdefault("key_strengths", [])
        feedback_data.setdefault("weaknesses", [])
        feedback_data.setdefault("how_to_improve", [])
        feedback_data.setdefault("recommended_topics", [])
        feedback_data.setdefault("summary", "")
        feedback_data["overall_score"] = max(0, min(100, float(feedback_data.get("overall_score", 0))))

        return jsonify(
            {
                "success": True,
                "feedback": feedback_data.get("summary", ""),
                "feedback_data": feedback_data,
                "candidate_name": candidate_name,
                "job_role": job_role,
                "interview_type": interview_type,
            }
        )
    except Exception as exc:
        logger.exception("Error generating interview feedback")
        return jsonify({"success": False, "message": f"Error generating feedback: {exc}"}), 500


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.getenv("FLASK_DEBUG", "False").lower() == "true")
