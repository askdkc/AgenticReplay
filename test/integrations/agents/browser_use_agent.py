"""Call browser-use's ChatOpenAI through the base URL set by the recorder."""

import asyncio

from browser_use import ChatOpenAI


async def main() -> None:
    llm = ChatOpenAI(model="stub-1")
    if hasattr(llm, "pydantic_model"):
        from pydantic_ai import Agent

        reply = await Agent(llm.pydantic_model()).run("hello")
        print("GOT:", reply.output)
    else:
        from browser_use.llm.messages import UserMessage

        reply = await llm.ainvoke([UserMessage(content="hello")])
        print("GOT:", reply.completion)


asyncio.run(main())
