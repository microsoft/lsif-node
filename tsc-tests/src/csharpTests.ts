/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { assertValid } from './lsifs';

suite('C# Tests', () => {

	test('Two related classes', async () => {
		/**
		 * This test consumes a C# LSIF file that's from a net6.0 Hello World project:
		 * 
		 * ----- Structure -----
		 * HelloWorld/
		 * 		obj/Debug/net6.0
		 * 			- HelloWorld.GlobalUsings.g.cs
		 * 			- HelloWorld.AssemblyInfo.cs
		 *			- .NETCoreApp,Version=v6.0.AssemblyAttributes.cs
		 * 		- HelloWorld.csproj
		 * 		- Person.cs
		 * 		- House.cs
		 * 
		 * ----- Person.cs -----
		 * using System.Text;
		 * 
		 * namespace SampleLibrary
		 * {
		 * 	public class Person
		 * 	{
		 * 		public string Name { get; set; } = default!;
		 * 
		 * 		public Person Parent { get; set; } = default!;
		 * 
		 * 		public void AppendTo(StringBuilder builder)
		 * 		{
		 * 			builder.Append(Name);
		 * 
		 * 			if (Parent is not null)
		 * 			{
		 * 				builder.Append(" <- ");
		 * 				Parent.AppendTo(builder);
		 * 			}
		 * 			else
		 * 			{
		 * 				builder.AppendLine();
		 * 			}
		 * 		}
		 * 	}
		 * }
		 * 
		 * ----- House.cs -----
		 * using System.Text;
		 * 
		 * namespace SampleLibrary
		 * {
		 * 	public class House
		 * 	{
		 * 		public string Address { get; set; } = default!;
		 * 
		 * 		public IReadOnlyList<Person> People { get; set; } = default!;
		 * 
		 * 		public void AppendTo(StringBuilder builder)
		 * 		{
		 * 			builder.AppendLine("Address: " + Address);
		 * 			builder.AppendLine("-------------------");
		 * 			for (var i = 0; i < People.Count; i++)
		 * 			{
		 * 				People[i].AppendTo(builder);
		 * 			}
		 * 		}
		 * 	}
		 * }
		 */

		await assertValid('outputs/twoRelatedClasses.lsif');
	});
});