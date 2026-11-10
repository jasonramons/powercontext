"""Build dify/memory-inn.dsl.yml from a Python structure (guaranteed-valid YAML)."""
import io
import yaml

PROMPT_SYSTEM = """你是《记忆旅馆》的叙述者。这是一个文字冒险游戏：玩家住进一家会记住客人的旅馆。
你只能基于下面给出的"世界事实"和"玩家记忆"来叙述，不要凭空发明新的房间名、人物名或物品名。
写作要求：
1. 用第二人称"你"，200 字以内，现在时态，氛围是潮湿、安静、略带不安的奇幻。
2. 必须体现至少一条"玩家记忆"（如果非空），用"老板低声说"或"你忽然想起"的方式自然带出。
3. 结尾给玩家一个可以立刻行动的选择提示（一句话，不要列清单）。
4. 不要输出 JSON，不要复述字段名。"""

PROMPT_USER = """玩家这一回合的行动：
{{#sys.query#}}

判定结果（是否接受、写入了什么记忆、命中的线索）：
{{#http_act.body#}}

本回合世界事实（房间、住客、传闻、物品）与玩家记忆：
{{#http_scene.body#}}"""

OPENING = """欢迎光临记忆旅馆。
这里的老板记得每一位客人——包括你上一次说过的谎。
输入你想做的事，比如「我问老板：你还记得我吗？」"""

HTTP_DEFAULTS = {
    "authorization": {"config": None, "type": "no-auth"},
    "headers": "Content-Type: application/json",
    "method": "post",
    "params": "",
    "retry_config": {"max_retries": 2, "retry_enabled": True, "retry_interval": 500},
    "selected": False,
    "ssl_verify": False,
    "timeout": {"max_connect_timeout": 0, "max_read_timeout": 0, "max_write_timeout": 0},
}


def http_node(node_id, title, desc, url, body, variables, x):
    data = dict(HTTP_DEFAULTS)
    data.update(
        {
            "desc": desc,
            "title": title,
            "type": "http-request",
            "url": url,
            "body": {"data": body, "type": "json"},
            "variables": variables,
        }
    )
    return {
        "data": data,
        "height": 120,
        "id": node_id,
        "position": {"x": x, "y": 300},
        "positionAbsolute": {"x": x, "y": 300},
        "selected": False,
        "sourcePosition": "right",
        "targetPosition": "left",
        "type": "custom",
        "width": 244,
    }


def edge(edge_id, source, target, source_type, target_type):
    return {
        "data": {"isInIteration": False, "sourceType": source_type, "targetType": target_type},
        "id": edge_id,
        "source": source,
        "sourceHandle": "source",
        "target": target,
        "targetHandle": "target",
    }


nodes = [
    {
        "data": {
            "desc": "玩家这一回合的输入",
            "selected": False,
            "title": "开始",
            "type": "start",
            "variables": [
                {
                    "label": "玩家",
                    "max_length": 64,
                    "options": [],
                    "required": False,
                    "type": "text-input",
                    "variable": "player",
                }
            ],
        },
        "height": 90,
        "id": "start",
        "position": {"x": 80, "y": 300},
        "positionAbsolute": {"x": 80, "y": 300},
        "selected": False,
        "sourcePosition": "right",
        "targetPosition": "left",
        "type": "custom",
        "width": 244,
    },
    http_node(
        "http_act",
        "旅馆判定",
        "判定这一回合：写入记忆、检索线索",
        "{{#env.INN_BASE_URL#}}/inn/act",
        '{"player":"{{#start.player#}}","action":"{{#sys.query#}}"}',
        [{"value_selector": ["http_act", "body"], "variable": "act_body"}],
        380,
    ),
    http_node(
        "http_scene",
        "场景与记忆",
        "从 seekdb 取场景事实，并从 PowerContext 取回记忆",
        "{{#env.INN_BASE_URL#}}/inn/scene",
        '{"player":"{{#start.player#}}","intent":"{{#sys.query#}}"}',
        [{"value_selector": ["http_scene", "body"], "variable": "scene_body"}],
        680,
    ),
    {
        "data": {
            "context": {"enabled": False, "variable_selector": []},
            "desc": "用世界事实 + 记忆写出这一回合",
            "model": {
                "completion_params": {"max_tokens": 512, "temperature": 0.9, "top_p": 0.95},
                "mode": "chat",
                "name": "qwen-plus",
                "provider": "langgenius/tongyi/tongyi",
            },
            "prompt_template": [
                {"role": "system", "text": PROMPT_SYSTEM},
                {"role": "user", "text": PROMPT_USER},
            ],
            "selected": False,
            "title": "叙述者",
            "type": "llm",
            "variables": [],
            "vision": {"enabled": False},
        },
        "height": 98,
        "id": "llm_narrate",
        "position": {"x": 980, "y": 300},
        "positionAbsolute": {"x": 980, "y": 300},
        "selected": False,
        "sourcePosition": "right",
        "targetPosition": "left",
        "type": "custom",
        "width": 244,
    },
    {
        "data": {
            "answer": "{{#llm_narrate.text#}}",
            "desc": "输出这一回合",
            "selected": False,
            "title": "回答",
            "type": "answer",
            "variables": [],
        },
        "height": 103,
        "id": "answer",
        "position": {"x": 1280, "y": 300},
        "positionAbsolute": {"x": 1280, "y": 300},
        "selected": False,
        "sourcePosition": "right",
        "targetPosition": "left",
        "type": "custom",
        "width": 244,
    },
]

dsl = {
    "app": {
        "description": (
            "记忆旅馆 —— 老板和住客会记得你上一次来过。Dify 负责叙事，"
            "seekdb 负责“这间房是什么”，PowerContext 负责“你来过几次、说过什么”。"
        ),
        "icon": "🏨",
        "icon_background": "#E0F2FE",
        "mode": "chat",
        "name": "记忆旅馆",
    },
    "kind": "app",
    "version": "0.1.5",
    "workflow": {
        "conversation_variables": [],
        "environment_variables": [
            {
                "description": "记忆旅馆世界服务地址",
                "id": "inn_base_url",
                "name": "INN_BASE_URL",
                "selector": [],
                "value": "http://127.0.0.1:8789",
                "value_type": "string",
            }
        ],
        "features": {
            "file_upload": {
                "allowed_file_extensions": [],
                "allowed_file_types": [],
                "allowed_file_upload_methods": [],
                "enabled": False,
                "image": {"enabled": False, "number_limits": 3, "transfer_methods": ["local_file", "remote_url"]},
                "number_limits": 3,
            },
            "opening_statement": OPENING,
            "retriever_resource": {"enabled": False},
            "sensitive_word_avoidance": {"enabled": False},
            "speech_to_text": {"enabled": False},
            "suggested_questions": [
                "我问老板：你还记得我吗？",
                "我去第七号信箱投一封信",
                "我照了照镜子",
            ],
            "suggested_questions_after_answer": {"enabled": False},
            "text_to_speech": {"enabled": False, "language": "", "voice": ""},
        },
        "graph": {
            "edges": [
                edge("edge-start-act", "start", "http_act", "start", "http-request"),
                edge("edge-act-scene", "http_act", "http_scene", "http-request", "http-request"),
                edge("edge-scene-llm", "http_scene", "llm_narrate", "http-request", "llm"),
                edge("edge-llm-answer", "llm_narrate", "answer", "llm", "answer"),
            ],
            "nodes": nodes,
            "viewport": {"x": 0, "y": 0, "zoom": 0.7},
        },
    },
}

text = yaml.safe_dump(dsl, allow_unicode=True, sort_keys=False, default_flow_style=False, width=200)
out = r"C:\Users\PC\Documents\deepseek-harness\default-workspace\memory-inn\dify\memory-inn.dsl.yml"
with io.open(out, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(text)

check = yaml.safe_load(io.open(out, encoding="utf-8"))
print("YAML OK, nodes:", [n["data"]["type"] for n in check["workflow"]["graph"]["nodes"]])
print("edges:", len(check["workflow"]["graph"]["edges"]))
print("bytes:", len(text.encode("utf-8")))
