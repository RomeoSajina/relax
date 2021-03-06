/*** Copyright 2016 Johannes Kessler 2016 Johannes Kessler
*
* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as i18n from 'i18next';
import { CodeInfo } from '../exec/CodeInfo';
import { Column } from '../exec/Column';
import { Difference } from '../exec/Difference';
import { Division } from '../exec/Division';
import { ExecutionError } from '../exec/ExecutionError';
import { AggregateFunction, GroupBy } from '../exec/GroupBy';
import { Intersect } from '../exec/Intersect';
import { AntiJoin } from '../exec/joins/AntiJoin';
import { CrossJoin } from '../exec/joins/CrossJoin';
import { FullOuterJoin } from '../exec/joins/FullOuterJoin';
import { InnerJoin } from '../exec/joins/InnerJoin';
import { JoinCondition } from '../exec/joins/Join';
import { LeftOuterJoin } from '../exec/joins/LeftOuterJoin';
import { RightOuterJoin } from '../exec/joins/RightOuterJoin';
import { SemiJoin } from '../exec/joins/SemiJoin';
import { OrderBy } from '../exec/OrderBy';
import { Projection, ProjectionColumn } from '../exec/Projection';
import { RANode } from '../exec/RANode';
import { Relation } from '../exec/Relation';
import { RenameColumns } from '../exec/RenameColumns';
import { RenameRelation } from '../exec/RenameRelation';
import { Schema } from '../exec/Schema';
import { Selection } from '../exec/Selection';
import { Union } from '../exec/Union';
import * as ValueExpr from '../exec/ValueExpr';



function parseJoinCondition(condition: relalgAst.booleanExpr | string[] | null): JoinCondition {
	if (condition === null) {
		return {
			type: 'natural',
			restrictToColumns: null,
		};
	}
	else if (Array.isArray(condition)) {
		return {
			type: 'natural',
			restrictToColumns: (condition as string[]),
		};
	}
	else {
		return {
			type: 'theta',
			joinExpression: recValueExpr(condition as relalgAst.booleanExpr),
		};
	}
}


// translate a SQL-AST to RA
export function relalgFromSQLAstRoot(astRoot: sqlAst.rootSql, relations: { [key: string]: Relation }): RANode {
	'use strict';

	function setCodeInfoFromNode(raNode: RANode, astNode: sqlAst.astNode) {
		if (!astNode.codeInfo) {
			throw new Error('should not happen');
		}

		raNode.setCodeInfoObject(astNode.codeInfo);
	}

	function rec(nRaw: sqlAst.astNode): RANode {
		let node: RANode | null = null;

		switch (nRaw.type) {
			case 'relation':
				{
					const n = nRaw;
					if (typeof (relations[n.name]) === 'undefined') {
						throw new ExecutionError(i18n.t('db.messages.translate.error-relation-not-found', { name: n.name }), n.codeInfo);
					}
					const rel = relations[n.name].copy();
					if (n.relAlias === null) {
						node = rel;
						break;
					}
					node = new RenameRelation(rel, n.relAlias);
				}
				break;

			case 'statement':
				{
					const n = nRaw;
					node = parseStatement(n);

					if (n.select.distinct === false) {
						node.addWarning(i18n.t('db.messages.translate.warning-distinct-missing'), n.codeInfo);
					}
				}
				break;

			case 'renameRelation':
				{
					const n = nRaw;
					node = new RenameRelation(rec(n.child), n.newRelAlias);
				}
				break;

			case 'relationFromSubstatement':
				{
					const n = nRaw;
					const rel = rec(n.statement);
					node = new RenameRelation(rel, n.relAlias);
				}
				break;

			case 'innerJoin':
			case 'leftOuterJoin':
			case 'rightOuterJoin':
			case 'fullOuterJoin':
				{
					const n = nRaw;
					const condition: JoinCondition = parseJoinCondition(n.cond);
					switch (n.type) {
						case 'innerJoin':
							node = new InnerJoin(rec(n.child), rec(n.child2), condition);
							break;
						case 'leftOuterJoin':
							node = new LeftOuterJoin(rec(n.child), rec(n.child2), condition);
							break;
						case 'rightOuterJoin':
							node = new RightOuterJoin(rec(n.child), rec(n.child2), condition);
							break;
						case 'fullOuterJoin':
							node = new FullOuterJoin(rec(n.child), rec(n.child2), condition);
							break;
					}
				}
				break;

			case 'crossJoin':
				{
					const n = nRaw;
					node = new CrossJoin(rec(n.child), rec(n.child2));
				}
				break;

			case 'naturalJoin':
				{
					const n = nRaw;
					node = new InnerJoin(rec(n.child), rec(n.child2), {
						type: 'natural',
						restrictToColumns: null,
					});
				}
				break;

			case 'union':
			case 'intersect':
			case 'except':
				{
					const n = nRaw;
					switch (n.type) {
						case 'union':
							node = new Union(rec(n.child), rec(n.child2));
							break;
						case 'intersect':
							node = new Intersect(rec(n.child), rec(n.child2));
							break;
						case 'except':
							node = new Difference(rec(n.child), rec(n.child2));
							break;
					}

					if (n.all === true) {
						if (!node) {
							throw new Error(`should not happen`);
						}
						node.addWarning(i18n.t('db.messages.translate.warning-ignored-all-on-set-operators'), n.codeInfo);
					}
				}
				break;

			case 'orderBy':
				{
					const n = nRaw;
					const orderCols = [];
					const orderAsc = [];
					for (let i = 0; i < n.arg.value.length; i++) {
						const e = n.arg.value[i];

						orderAsc.push(e.asc);
						orderCols.push(new Column(e.col.name, e.col.relAlias));
					}
					node = new OrderBy(rec(n.child), orderCols, orderAsc);
				}
				break;

			case 'limit':
				{
					const n = nRaw;
					const limit = n.limit;
					const offset = n.offset;

					const conditionOffset = new ValueExpr.ValueExprGeneric('boolean', '>', [
						new ValueExpr.ValueExprGeneric('number', 'rownum', []),
						new ValueExpr.ValueExprGeneric('number', 'constant', [offset]),
					]);

					if (limit === -1) {
						// === LIMIT ALL => only offset
						node = new Selection(rec(n.child), conditionOffset);
					}
					else {
						// limit and offset
						const conditionLimit = new ValueExpr.ValueExprGeneric('boolean', '<=', [
							new ValueExpr.ValueExprGeneric('number', 'rownum', []),
							new ValueExpr.ValueExprGeneric('number', 'constant', [limit + offset]),
						]);
						node = new Selection(rec(n.child), new ValueExpr.ValueExprGeneric('boolean', 'and', [conditionOffset, conditionLimit]));
					}
					break;
				}

			default:
				throw new Error(`type ${nRaw.type} not implemented`);
		}

		if (!node) {
			throw new Error(`should not happen`);
		}

		if (nRaw.wrappedInParentheses === true) {
			node.setWrappedInParentheses(true);
		}

		setCodeInfoFromNode(node, nRaw);
		return node;
	}

	function getSelection(root: RANode, condition: sqlAst.booleanExpr, codeInfo: CodeInfo) {
		root.check();
		const node = new Selection(root, recValueExpr(condition));
		node.setCodeInfoObject(codeInfo);
		return node;
	}


	function isNamedColumn(arg: any): arg is sqlAst.namedColumn {
		return arg.type === 'column' && arg.alias;
	}

	function parseStatement(statement: sqlAst.statement) {
		const projectionArgs = statement.select.arg;

		// from-CLAUSE
		let root = rec(statement.from);
		setCodeInfoFromNode(root, statement.from);
		root.check();

		// selection
		if (statement.where !== null) {
			root = getSelection(root, statement.where.arg, statement.where.codeInfo);
			setCodeInfoFromNode(root, statement.where);
		}

		// group-by + aggregation
		if (statement.groupBy !== null || statement.numAggregationColumns > 0) {
			const aggregateFunctions: AggregateFunction[] = [];
			const groupByCols = statement.groupBy || [];

			// filter aggFunctions from SELECT list
			for (let i = 0; i < projectionArgs.length; i++) {
				const col = projectionArgs[i];
				if (col.type === 'aggFunction') {
					aggregateFunctions.push(col);
				}
			}

			if (aggregateFunctions.length > 0) {
				root = new GroupBy(root, groupByCols, aggregateFunctions);
			}
			else {
				// use projection if no aggregation is used
				const projections: Column[] = [];
				for (let i = 0; i < groupByCols.length; i++) {
					const col = groupByCols[i];
					projections.push(new Column(col.name, col.relAlias));
				}
				root = new Projection(root, projections);
			}
		}


		// having
		if (statement.having !== null) {
			root = getSelection(root, statement.having.arg, statement.having.codeInfo);
			setCodeInfoFromNode(root, statement.having);
		}

		// projection
		let colsRenamed = false;
		if (projectionArgs.length === 1 && projectionArgs[0].type === 'column' && (projectionArgs[0] as sqlAst.columnName).name === '*' && (projectionArgs[0] as sqlAst.columnName).relAlias === null) {
			// select * => no projection needed
		}
		else {
			const projections: ProjectionColumn[] = [];
			for (let i = 0; i < projectionArgs.length; i++) {
				const col = projectionArgs[i];

				if (col.type === 'aggFunction') {
					projections.push(new Column(col.name, null)); // has been renamed by gamma
				}
				else if (col.type === 'namedColumnExpr') {
					projections.push({
						name: col.name,
						relAlias: col.relAlias,
						child: recValueExpr(col.child),
					});
				}
				else if (col.type === 'column') {
					// normal columns
					projections.push(new Column(col.name, col.relAlias));

					if (isNamedColumn(col)) {
						colsRenamed = true;
					}
				}
				else {
					throw new Error('this should not happen');
				}
			}
			root = new Projection(root, projections);
			setCodeInfoFromNode(root, statement.select);
		}

		// rename columns
		if (colsRenamed === true) {
			const tmp = new RenameColumns(root);

			for (let i = 0; i < projectionArgs.length; i++) {
				const arg = projectionArgs[i];
				if (isNamedColumn(arg)) {
					tmp.addRenaming(arg.alias, arg.name, arg.relAlias);
				}
			}
			root = tmp;
		}

		return root;
	}

	return rec(astRoot.child);
}

function recValueExpr(n: relalgAst.valueExpr | sqlAst.valueExpr): ValueExpr.ValueExpr {
	let node: ValueExpr.ValueExpr;
	if (n.datatype === 'null' && n.func === 'columnValue') {
		node = new ValueExpr.ValueExprColumnValue(n.args[0], n.args[1]);
	}
	else {
		switch (n.datatype) {
			case 'string':
			case 'number':
			case 'boolean':
			case 'date':
			case 'null': // all with unknown type
				const tmp = [];
				for (let i = 0; i < n.args.length; i++) {
					if (n.func === 'constant') {
						tmp.push(n.args[i]);
					}
					else {
						tmp.push(recValueExpr(n.args[i]));
					}
				}

				node = new ValueExpr.ValueExprGeneric(n.datatype, n.func, tmp);
				break;
			default:
				throw new Error('not implemented yet');
		}
	}

	node.setCodeInfoObject(n.codeInfo);
	if (n.wrappedInParentheses === true) {
		node.setWrappedInParentheses(true);
	}
	return node;
}

function setAdditionalData<T extends RANode>(astNode: relalgAst.relalgOperation, node: T): void {
	node.setCodeInfoObject(astNode.codeInfo);

	if (typeof (astNode.metaData) !== 'undefined') {
		for (const key in astNode.metaData) {
			if (!astNode.metaData.hasOwnProperty(key)) {
				continue;
			}

			node.setMetaData(key as any, astNode.metaData[key]);
		}
	}

	if (astNode.wrappedInParentheses === true) {
		node.setWrappedInParentheses(true);
	}
}



// translates a RA-AST to RA
export function relalgFromRelalgAstRoot(astRoot: relalgAst.rootRelalg, relations: { [key: string]: Relation }) {
	// root is the real root node! of a statement
	return relalgFromRelalgAstNode(astRoot.child, relations);
}

/**
 * translates a RA-AST node to RA
 * @param   {Object} astNode   a node of a RA-AST
 * @param   {Object} relations hash of the relations that could be used in the statement
 * @returns {Object} an actual RA-expression
 */
export function relalgFromRelalgAstNode(astNode: relalgAst.relalgOperation, relations: { [key: string]: Relation }): RANode {
	function recRANode(n: relalgAst.relalgOperation): RANode {
		switch (n.type) {
			case 'relation':
				{
					if (typeof (relations[n.name]) === 'undefined') {
						throw new ExecutionError(i18n.t('db.messages.translate.error-relation-not-found', { name: n.name }), n.codeInfo);
					}
					const node = relations[n.name].copy();
					setAdditionalData(n, node);
					return node;
				}

			case 'table':
				{
					const schema = new Schema();
					for (let i = 0; i < n.columns.length; i++) {
						const col = n.columns[i];
						schema.addColumn(col.name, col.relAlias, col.type);
					}

					const rel = new Relation(n.name);
					rel.setSchema(schema, true);
					rel.addRows(n.rows);
					rel.setMetaData('isInlineRelation', true);
					rel.setMetaData('inlineRelationDefinition', n.codeInfo.text);
					// TODO: inlineRelationDefinition should be replaced; there should be a generic way to get the definition of a node
					const node = rel;
					setAdditionalData(n, node);
					return node;
				}

			case 'selection':
				{
					const child = recRANode(n.child);
					const condition = recValueExpr(n.arg);
					const node = new Selection(child, condition);
					setAdditionalData(n, node);
					return node;
				}

			case 'projection':
				{
					const child = recRANode(n.child);
					const projections: (Column | {
						name: string | number,
						relAlias: string,
						child: ValueExpr.ValueExpr,
					})[] = [];
					for (let i = 0; i < n.arg.length; i++) {
						const el = n.arg[i];

						if (el.type === 'columnName') {
							const e = el as relalgAst.columnName;
							projections.push(new Column(e.name, e.relAlias));
						}
						else if (el.type === 'namedColumnExpr') {
							const e = el as relalgAst.namedColumnExpr;
							// namedColumnExpr
							projections.push({
								name: e.name,
								relAlias: e.relAlias,
								child: recValueExpr(e.child),
							});
						}
						else {
							throw new Error('should not happen');
						}
					}

					const node = new Projection(child, projections);
					setAdditionalData(n, node);
					return node;
				}

			case 'orderBy':
				{
					const child = recRANode(n.child);
					const orderCols: Column[] = [];
					const orderAsc: boolean[] = [];

					for (let i = 0; i < n.arg.length; i++) {
						const e = n.arg[i];

						orderAsc.push(e.asc);
						orderCols.push(new Column(e.col.name, e.col.relAlias));
					}

					const node = new OrderBy(child, orderCols, orderAsc);
					setAdditionalData(n, node);
					return node;
				}

			case 'groupBy':
				{
					const child = recRANode(n.child);
					const aggregateFunctions = n.aggregate;
					const groupByCols = n.group;

					const node = new GroupBy(child, groupByCols, aggregateFunctions);
					setAdditionalData(n, node);
					return node;
				}

			case 'union':
				{
					const child = recRANode(n.child);
					const child2 = recRANode(n.child2);
					const node = new Union(child, child2);
					setAdditionalData(n, node);
					return node;
				}

			case 'intersect':
				{
					const child = recRANode(n.child);
					const child2 = recRANode(n.child2);
					const node = new Intersect(child, child2);
					setAdditionalData(n, node);
					return node;
				}

			case 'division':
				{
					const child = recRANode(n.child);
					const child2 = recRANode(n.child2);
					const node = new Division(child, child2);
					setAdditionalData(n, node);
					return node;
				}

			case 'difference':
				{
					const child = recRANode(n.child);
					const child2 = recRANode(n.child2);
					const node = new Difference(child, child2);
					setAdditionalData(n, node);
					return node;
				}

			case 'renameColumns':
				{
					const ren = new RenameColumns(recRANode(n.child));

					for (let i = 0; i < n.arg.length; i++) {
						const e = n.arg[i];

						ren.addRenaming(e.dst, e.src.name, e.src.relAlias);
					}

					const node = ren;
					setAdditionalData(n, node);
					return node;
				}

			case 'renameRelation':
				{
					const child = recRANode(n.child);
					const node = new RenameRelation(child, n.newRelAlias);
					setAdditionalData(n, node);
					return node;
				}

			case 'thetaJoin':
				{
					const condition: JoinCondition = {
						type: 'theta',
						joinExpression: recValueExpr(n.arg),
					};
					const child = recRANode(n.child);
					const child2 = recRANode(n.child2);
					const node = new InnerJoin(child, child2, condition);
					setAdditionalData(n, node);
					return node;
				}

			case 'crossJoin':
				{
					const child = recRANode(n.child);
					const child2 = recRANode(n.child2);
					const node = new CrossJoin(child, child2);
					setAdditionalData(n, node);
					return node;
				}

			case 'naturalJoin':
				{
					const child = recRANode(n.child);
					const child2 = recRANode(n.child2);
					const node = new InnerJoin(child, child2, {
						type: 'natural',
						restrictToColumns: null,
					});
					setAdditionalData(n, node);
					return node;
				}

			case 'leftSemiJoin':
				{
					const child = recRANode(n.child);
					const child2 = recRANode(n.child2);
					const node = new SemiJoin(child, child2, true);
					setAdditionalData(n, node);
					return node;
				}

			case 'rightSemiJoin':
				{
					const child = recRANode(n.child);
					const child2 = recRANode(n.child2);
					const node = new SemiJoin(child, child2, false);
					setAdditionalData(n, node);
					return node;
				}

			case 'antiJoin':
				{
					const child = recRANode(n.child);
					const child2 = recRANode(n.child2);
					const node = new AntiJoin(child, child2);
					setAdditionalData(n, node);
					return node;
				}

			case 'leftOuterJoin':
				{
					const child = recRANode(n.child);
					const child2 = recRANode(n.child2);
					const condition = parseJoinCondition(n.arg);
					const node = new LeftOuterJoin(child, child2, condition);
					setAdditionalData(n, node);
					return node;
				}

			case 'rightOuterJoin':
				{
					const child = recRANode(n.child);
					const child2 = recRANode(n.child2);
					const condition = parseJoinCondition(n.arg);
					const node = new RightOuterJoin(child, child2, condition);
					setAdditionalData(n, node);
					return node;
				}

			case 'fullOuterJoin':
				{
					const child = recRANode(n.child);
					const child2 = recRANode(n.child2);
					const condition = parseJoinCondition(n.arg);
					const node = new FullOuterJoin(child, child2, condition);
					setAdditionalData(n, node);
					return node;
				}
		}
	}

	return recRANode(astNode);
}
